// ============================================================
//  Wallet P2P Monitoring Bot
//  Мониторит цены на P2P маркете и шлёт алерты в Telegram
// ============================================================

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const express = require('express');

// ─── Config ─────────────────────────────────────────────────
const {
  BOT_TOKEN,
  CHAT_ID,
  WALLET_API_KEY,
  CHECK_INTERVAL = '30',
  CRYPTO_CURRENCY = 'USDT',
  SELL_THRESHOLD_KZT = '',
  BUY_THRESHOLD_KZT = '',
  SELL_THRESHOLD_RUB = '',
  BUY_THRESHOLD_RUB = '',
  PORT = '3000',
} = process.env;

// Validate required env vars
if (!BOT_TOKEN || !CHAT_ID || !WALLET_API_KEY) {
  console.error('❌ Missing required env vars: BOT_TOKEN, CHAT_ID, WALLET_API_KEY');
  process.exit(1);
}

const INTERVAL_MS = parseInt(CHECK_INTERVAL, 10) * 1000;

// ─── Multi-pair config ──────────────────────────────────────
// Each pair has its own thresholds, prices, and state
const PAIRS = ['KZT', 'RUB'];

// ─── RUB Payment Filter ─────────────────────────────────────
// SELL (мы даём рубли, получаем USDT) → СБП + ЮMoney
// BUY  (мы даём USDT, получаем рубли) → только ЮMoney
// Сбер, Т-Банк, ВТБ и прочие автоматически исключены для обоих сторон.
// KZT — фильтр не применяется.
const RUB_PAYMENTS_BY_SIDE = {
  SELL: ['sbp', 'yoomoney'],   // покупаем USDT за рубли
};

function filterAndLimitAds(ads, fiatCurrency, side) {
  if (fiatCurrency !== 'RUB') return ads; // KZT — без фильтра
  const allowed = RUB_PAYMENTS_BY_SIDE[side] || [];
  let filtered = ads.filter((ad) =>
    (ad.payments || []).some((p) => allowed.includes(p.toLowerCase()))
  );

  // Apply 3,500 RUB limit for SBP ads in RUB SELL (if they don't also support YooMoney)
  if (side === 'SELL') {
    filtered = filtered.filter((ad) => {
      const hasSbp = (ad.payments || []).some((p) => p.toLowerCase() === 'sbp');
      const hasYoomoney = (ad.payments || []).some((p) => p.toLowerCase() === 'yoomoney');
      if (hasSbp && !hasYoomoney) {
        const min = parseFloat(ad.minAmount);
        const max = parseFloat(ad.maxAmount);
        return min <= 3500 && max >= 3500;
      }
      return true;
    });
  }

  return filtered;
}

let pairConfigs = {
  KZT: {
    cryptoCurrency: CRYPTO_CURRENCY,
    fiatCurrency: 'KZT',
    side: 'SELL',
    sellThreshold: SELL_THRESHOLD_KZT ? parseFloat(SELL_THRESHOLD_KZT) : null,
    lastBestPrice: { SELL: null },
  },
  RUB: {
    cryptoCurrency: CRYPTO_CURRENCY,
    fiatCurrency: 'RUB',
    side: 'SELL',
    sellThreshold: SELL_THRESHOLD_RUB ? parseFloat(SELL_THRESHOLD_RUB) : null,
    lastBestPrice: { SELL: null },
  },
};

// ─── State ──────────────────────────────────────────────────
let monitoring = true;
let lastCheckTime = null;
let totalChecks = 0;
let totalAlerts = 0;
let checkTimer = null;

// ─── Wallet P2P API ─────────────────────────────────────────
const API_URL = 'https://p2p.walletbot.me/p2p/integration-api/v1/item/online';

async function fetchAds(pairConfig, sideToFetch, page = 1, pageSize = 20) {
  try {
    const response = await axios.post(API_URL, {
      cryptoCurrency: pairConfig.cryptoCurrency,
      fiatCurrency: pairConfig.fiatCurrency,
      side: sideToFetch,
      page,
      pageSize,
    }, {
      headers: {
        'X-API-Key': WALLET_API_KEY,
        'Content-Type': 'application/json',
        'accept': 'application/json',
      },
      timeout: 15000,
    });

    if (response.data && response.data.status === 'SUCCESS') {
      return response.data.data || [];
    }

    console.warn('⚠️  API returned non-SUCCESS status:', response.data?.status);
    return [];
  } catch (error) {
    const msg = error.response
      ? `HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`
      : error.message;
    console.error('❌ API Error:', msg);
    return null;
  }
}

async function fetchAllAds(pairConfig, sideToFetch) {
  const pages = [1, 2, 3, 4, 5];
  const promises = pages.map((page) => fetchAds(pairConfig, sideToFetch, page, 50));
  const results = await Promise.all(promises);

  const allAds = [];
  const seenIds = new Set();

  for (const ads of results) {
    if (ads) {
      for (const ad of ads) {
        if (!seenIds.has(ad.id)) {
          seenIds.add(ad.id);
          allAds.push(ad);
        }
      }
    }
  }

  if (results.every(r => r === null)) return null;

  return allAds;
}

// ─── Price Analysis ─────────────────────────────────────────
function analyzeAds(ads, sideToFetch) {
  if (!ads || ads.length === 0) return null;

  const prices = ads.map((ad) => parseFloat(ad.price));
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);

  const bestPrice = sideToFetch === 'SELL' ? minPrice : maxPrice;
  const worstPrice = sideToFetch === 'SELL' ? maxPrice : minPrice;

  const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;

  const bestAd = ads.find((ad) => parseFloat(ad.price) === bestPrice);

  return {
    bestPrice,
    worstPrice,
    avgPrice: Math.round(avgPrice * 100) / 100,
    spread: Math.round(Math.abs(maxPrice - minPrice) * 100) / 100,
    totalAds: ads.length,
    bestAd,
  };
}

// ─── Telegram Bot ───────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);

// Format price nicely
function fmtPrice(price) {
  return Number(price).toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Side label in Russian
function sideLabel(side) {
  if (side === 'BOTH') return 'Обе стороны (Купить, Продать)';
  return side === 'SELL' ? '🔴 Купить (SELL)' : '🟢 Продать (BUY)';
}

// ─── Inline Keyboard ───────────────────────────────────────
function mainInlineKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('🛒 Порог КУПИТЬ KZT', 'set_thresh_sell_KZT'),
      Markup.button.callback('🛒 Порог КУПИТЬ RUB', 'set_thresh_sell_RUB'),
    ],
  ]);
}

// Reply keyboard — always visible, shown on /start
const mainKeyboard = Markup.keyboard([
  ['📊 Статус', '🔎 Проверить цену'],
  ['🛒 Порог KZT', '🛒 Порог RUB'],
  ['⏸ Пауза', '▶️ Возобновить']
], { is_persistent: true }).resize();

// Build a status message (now multi-pair)
function buildStatusMessage() {
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const mins = Math.floor((uptime % 3600) / 60);

  const lines = [
    `📊 *Статус мониторинга*`,
    ``,
    `• Состояние: ${monitoring ? '✅ Активен' : '⏸ Приостановлен'}`,
    `• Интервал: ${CHECK_INTERVAL} сек`,
    ``,
  ];

  for (const fiat of PAIRS) {
    const pc = pairConfigs[fiat];
    lines.push(
      `━━━ *USDT/${fiat}* ━━━`,
      `• Порог КУПИТЬ: ${pc.sellThreshold ? fmtPrice(pc.sellThreshold) : 'не задан'}`,
      `• Цена КУПИТЬ: ${pc.lastBestPrice.SELL !== null ? fmtPrice(pc.lastBestPrice.SELL) : '—'}`,
      ``,
    );
  }

  lines.push(
    `📈 *Статистика*`,
    `• Проверок: ${totalChecks}`,
    `• Алертов: ${totalAlerts}`,
    `• Последняя проверка: ${lastCheckTime ? lastCheckTime.toLocaleTimeString('ru-RU') : '—'}`,
    `• Аптайм: ${hours}ч ${mins}м`,
  );

  return lines.join('\n');
}

// Build simplified price alert message
function buildAlertMessage(analysis, side, fiat) {
  const { bestPrice, totalAds, bestAd } = analysis;
  const sideTitle = side === 'SELL' ? 'ВЫ МОЖЕТЕ КУПИТЬ' : 'ВЫ МОЖЕТЕ ПРОДАТЬ';

  const lines = [
    `🔔 *${sideTitle}* (${fiat})`,
    ``,
    `💰 *Цена:* \`${fmtPrice(bestPrice)} ${fiat}\``,
  ];

  if (bestAd) {
    lines.push(
      ``,
      `👤 *Продавец:* ${bestAd.nickname || '—'}`,
      `💳 *Оплата:* ${(bestAd.payments || []).join(', ') || '—'}`,
      `📏 *Лимит:* ${fmtPrice(bestAd.minAmount)}–${fmtPrice(bestAd.maxAmount)} ${fiat}`
    );
  }

  lines.push(``, `📊 Объявлений: ${totalAds}`);

  return lines.join('\n');
}

// Send message to chat
async function sendAlert(text) {
  try {
    await bot.telegram.sendMessage(CHAT_ID, text, { parse_mode: 'Markdown' });
    totalAlerts++;
  } catch (err) {
    console.error('❌ Failed to send Telegram message:', err.message);
  }
}

// ─── Main Check Loop ────────────────────────────────────────
async function checkSidePrices(pairConfig, side) {
  const fiat = pairConfig.fiatCurrency;
  const rawAds = await fetchAllAds(pairConfig, side);

  if (rawAds === null) {
    console.log(`⚠️  [${new Date().toLocaleTimeString()}] API error for ${side} ${fiat}, retrying...`);
    return;
  }

  // Apply payment filter and limits
  const ads = filterAndLimitAds(rawAds, fiat, side);

  if (ads.length === 0) {
    console.log(`📭 [${new Date().toLocaleTimeString()}] No ads found for ${side} ${fiat}`);
    return;
  }

  const analysis = analyzeAds(ads, side);
  if (!analysis) return;

  const { bestPrice } = analysis;
  console.log(`✅ [${lastCheckTime.toLocaleTimeString()}] ${fiat} ${side} Best: ${fmtPrice(bestPrice)} | Ads: ${analysis.totalAds}`);

  // Determine if we should send an alert
  let shouldAlert = false;
  const prevPrice = pairConfig.lastBestPrice[side];
  const threshold = pairConfig.sellThreshold;

  if (threshold && bestPrice !== prevPrice) {
    if (bestPrice <= threshold) {
      shouldAlert = true;
    }
  }

  if (shouldAlert) {
    await sendAlert(buildAlertMessage(analysis, side, fiat));
  }

  pairConfig.lastBestPrice[side] = bestPrice;
}

async function checkPrices() {
  if (!monitoring) return;

  totalChecks++;
  lastCheckTime = new Date();

  // Fire all pair+side combinations in parallel
  const tasks = [];
  for (const fiat of PAIRS) {
    const pc = pairConfigs[fiat];
    tasks.push(checkSidePrices(pc, 'SELL'));
  }
  await Promise.all(tasks);
}

// ─── Bot Commands ───────────────────────────────────────────

// Security middleware
bot.use((ctx, next) => {
  if (String(ctx.from?.id) !== String(CHAT_ID)) {
    return ctx.reply('⛔ Доступ запрещён');
  }
  return next();
});

bot.command('start', (ctx) => {
  ctx.reply(
    `👋 *Привет! Я P2P Monitor Bot*\n\n` +
    `Я мониторю пары USDT/KZT и USDT/RUB (покупка USDT).\n` +
    `Используйте кнопки для навигации 👇`,
    { parse_mode: 'Markdown', ...mainKeyboard }
  );
});

bot.command('help', (ctx) => {
  ctx.reply(
    `📖 *Справка P2P Monitor*\n\n` +
    `*Команды:*\n` +
    `/status — статус бота и статистика\n` +
    `/price — мгновенная проверка цены\n` +
    `/pause — остановить проверки\n` +
    `/resume — запустить проверки\n` +
    `/set\\_threshold <kzt|rub> <цена> — установить порог покупки\n\n` +
    `*Примеры:*\n` +
    `\`/set_threshold kzt 445\` — алерт, если цена покупки KZT <= 445\n` +
    `\`/set_threshold rub 95\` — алерт, если цена покупки RUB <= 95\n\n` +
    `*Мониторинг:*\n` +
    `• Пары: USDT/KZT и USDT/RUB (только покупка USDT)\n` +
    `• Проверка каждые ${CHECK_INTERVAL} сек\n` +
    `• Алерт приходит, если цена достигает порога`,
    { parse_mode: 'Markdown', ...mainKeyboard }
  );
});

bot.command('status', (ctx) => {
  ctx.reply(buildStatusMessage(), { parse_mode: 'Markdown', ...mainInlineKeyboard() });
});

bot.command('price', async (ctx) => {
  ctx.reply('🔍 Проверяю...');
  for (const fiat of PAIRS) {
    const pc = pairConfigs[fiat];
    const rawAds = await fetchAllAds(pc, 'SELL');
    if (rawAds === null) {
      await ctx.reply(`❌ Ошибка API для КУПИТЬ ${fiat}. Попробуй позже.`);
      continue;
    }
    const ads = filterAndLimitAds(rawAds, fiat, 'SELL');
    if (ads.length === 0) {
      await ctx.reply(`📭 Объявлений не найдено для КУПИТЬ ${fiat}${fiat === 'RUB' ? ' (фильтр СБП/ЮMoney)' : ''}.`);
      continue;
    }
    const analysis = analyzeAds(ads, 'SELL');
    await ctx.reply(buildAlertMessage(analysis, 'SELL', fiat), { parse_mode: 'Markdown' });
  }
});

const topHandler = async (ctx) => {
  ctx.reply('🔍 Загружаю топ...');
  for (const fiat of PAIRS) {
    const pc = pairConfigs[fiat];
    const rawAds = await fetchAllAds(pc, 'SELL');
    if (rawAds === null) {
      await ctx.reply(`❌ Ошибка API для КУПИТЬ ${fiat}.`);
      continue;
    }
    const ads = filterAndLimitAds(rawAds, fiat, 'SELL');
    if (ads.length === 0) {
      await ctx.reply(`📭 Объявлений не найдено для КУПИТЬ ${fiat}${fiat === 'RUB' ? ' (фильтр СБП/ЮMoney)' : ''}.`);
      continue;
    }

    const sorted = [...ads].sort((a, b) => {
      const pa = parseFloat(a.price);
      const pb = parseFloat(b.price);
      return pa - pb;
    });
    const top5 = sorted.slice(0, 5);

    const lines = [
      `🏆 *Топ-5 предложений*`,
      `\`USDT/${fiat}\` | ${sideLabel('SELL')}`,
      ``,
    ];

    top5.forEach((ad, i) => {
      const medal = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'][i];
      const rate = ad.executeRate ? (parseFloat(ad.executeRate) * 100).toFixed(1) + '%' : '—';
      lines.push(
        `${medal} *${fmtPrice(ad.price)} ${fiat}*`,
        `   👤 ${ad.nickname || '—'} | ⭐ ${rate} | 📦 ${ad.orderNum || 0} сделок`,
        `   💳 ${(ad.payments || []).join(', ') || '—'}`,
        `   📏 ${fmtPrice(ad.minAmount)}–${fmtPrice(ad.maxAmount)} ${fiat}`,
        ``,
      );
    });

    lines.push(`📊 Всего объявлений: ${ads.length}`);
    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
  }
};

bot.command('top', topHandler);

bot.command('pause', (ctx) => {
  if (!monitoring) return ctx.reply('⏸ Мониторинг уже приостановлен.');
  monitoring = false;
  ctx.reply('⏸ Мониторинг приостановлен. Нажмите «Возобновить» чтобы продолжить.', mainInlineKeyboard());
});

bot.command('resume', (ctx) => {
  if (monitoring) return ctx.reply('✅ Мониторинг уже работает.');
  monitoring = true;
  // Reset prices
  for (const fiat of PAIRS) {
    pairConfigs[fiat].lastBestPrice = { SELL: null };
  }
  ctx.reply('▶️ Мониторинг возобновлён!', mainInlineKeyboard());
  checkPrices();
});

// ─── Inline Button Handlers ─────────────────────────────────

bot.action('action_status', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(buildStatusMessage(), { parse_mode: 'Markdown', ...mainInlineKeyboard() });
});

// Threshold inline buttons — ask user to type the value
bot.action(/^set_thresh_sell_(KZT|RUB)$/, async (ctx) => {
  const fiat = ctx.match[1];
  await ctx.answerCbQuery();
  waitingForThreshold = { side: 'SELL', fiat };
  await ctx.reply(
    `Введите новую цену для порога КУПИТЬ (${fiat}).\n` +
    `Текущий порог: ${pairConfigs[fiat].sellThreshold ? fmtPrice(pairConfigs[fiat].sellThreshold) : 'не задан'}`,
    Markup.forceReply()
  );
});

// ─── Reply Keyboard Handlers ────────────────────────────────

bot.hears('📊 Статус', (ctx) => {
  ctx.reply(buildStatusMessage(), { parse_mode: 'Markdown', ...mainInlineKeyboard() });
});

bot.hears('🔎 Проверить цену', async (ctx) => {
  ctx.reply('🔍 Проверяю...');
  for (const fiat of PAIRS) {
    const pc = pairConfigs[fiat];
    const rawAds = await fetchAllAds(pc, 'SELL');
    if (rawAds === null) {
      await ctx.reply(`❌ Ошибка API для КУПИТЬ ${fiat}. Попробуй позже.`);
      continue;
    }
    const ads = filterAndLimitAds(rawAds, fiat, 'SELL');
    if (ads.length === 0) {
      await ctx.reply(`📭 Объявлений не найдено для КУПИТЬ ${fiat}${fiat === 'RUB' ? ' (фильтр СБП/ЮMoney)' : ''}.`);
      continue;
    }
    const analysis = analyzeAds(ads, 'SELL');
    await ctx.reply(buildAlertMessage(analysis, 'SELL', fiat), { parse_mode: 'Markdown' });
  }
});

let waitingForThreshold = null; // { side: 'SELL', fiat: 'KZT'|'RUB' }

bot.hears('🛒 Порог KZT', (ctx) => {
  waitingForThreshold = { side: 'SELL', fiat: 'KZT' };
  ctx.reply(
    `Введите новую цену для порога КУПИТЬ (KZT).\nТекущий: ${pairConfigs.KZT.sellThreshold ? fmtPrice(pairConfigs.KZT.sellThreshold) : 'не задан'}`,
    Markup.forceReply()
  );
});

bot.hears('🛒 Порог RUB', (ctx) => {
  waitingForThreshold = { side: 'SELL', fiat: 'RUB' };
  ctx.reply(
    `Введите новую цену для порога КУПИТЬ (RUB).\nТекущий: ${pairConfigs.RUB.sellThreshold ? fmtPrice(pairConfigs.RUB.sellThreshold) : 'не задан'}`,
    Markup.forceReply()
  );
});

bot.hears('⏸ Пауза', (ctx) => {
  if (!monitoring) return ctx.reply('⏸ Мониторинг уже приостановлен.');
  monitoring = false;
  ctx.reply('⏸ Мониторинг приостановлен. Нажмите «Возобновить» чтобы продолжить.', mainInlineKeyboard());
});

bot.hears('▶️ Возобновить', (ctx) => {
  if (monitoring) return ctx.reply('✅ Мониторинг уже работает.');
  monitoring = true;
  // Reset prices
  for (const fiat of PAIRS) {
    pairConfigs[fiat].lastBestPrice = { SELL: null };
  }
  ctx.reply('▶️ Мониторинг возобновлён!', mainInlineKeyboard());
  checkPrices();
});

// Handle threshold text input
bot.on('text', (ctx, next) => {
  const text = ctx.message.text;

  // Ignore commands and known buttons
  if (text.startsWith('/') || [
    '📊 Статус', '🔎 Проверить цену',
    '🛒 Порог KZT', '🛒 Порог RUB',
    '⏸ Пауза', '▶️ Возобновить'
  ].includes(text)) {
    return next();
  }

  const isReply = ctx.message.reply_to_message?.text?.includes('Введите новую цену для порога');

  if (isReply || waitingForThreshold) {
    const val = parseFloat(text.replace(',', '.'));
    if (!isNaN(val)) {
      let threshInfo = waitingForThreshold;

      // If replying to a specific message, parse the side & fiat from it
      if (isReply && ctx.message.reply_to_message.text) {
        const replyText = ctx.message.reply_to_message.text;
        const fiatMatch = replyText.match(/(KZT|RUB)/);
        threshInfo = {
          side: 'SELL',
          fiat: fiatMatch ? fiatMatch[1] : (waitingForThreshold?.fiat || 'KZT'),
        };
      }

      if (!threshInfo) threshInfo = { side: 'SELL', fiat: 'KZT' };

      const pc = pairConfigs[threshInfo.fiat];
      pc.sellThreshold = val;

      waitingForThreshold = null;
      return ctx.reply(
        `✅ Порог КУПИТЬ (${threshInfo.fiat}) установлен: *${fmtPrice(val)} ${threshInfo.fiat}*`,
        { parse_mode: 'Markdown', ...mainInlineKeyboard() }
      );
    }
  }

  return next();
});

// /set_threshold <kzt|rub> <price>
bot.command('set_threshold', (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 2) {
    return ctx.reply(
      '⚠️ Использование: `/set_threshold <kzt|rub> <цена>`\n' +
      'Например: `/set_threshold kzt 445`',
      { parse_mode: 'Markdown' }
    );
  }

  const fiat = args[0].toUpperCase();
  const val = parseFloat(args[1].replace(',', '.'));

  if (!PAIRS.includes(fiat)) {
    return ctx.reply('❌ Укажите валюту: `kzt` или `rub`', { parse_mode: 'Markdown' });
  }
  if (isNaN(val)) {
    return ctx.reply('❌ Введите корректное число (например: 490.50)');
  }

  const pc = pairConfigs[fiat];
  pc.sellThreshold = val;

  ctx.reply(
    `🎯 Порог КУПИТЬ (${fiat}) установлен: *${fmtPrice(val)} ${fiat}*`,
    { parse_mode: 'Markdown', ...mainInlineKeyboard() }
  );
});

// ─── Express Keep-Alive Server (for Render) ─────────────────
const app = express();
const startTime = Date.now();

app.get('/', (req, res) => {
  res.json({
    status: 'running',
    bot: 'P2P Monitor',
    monitoring,
    uptime: `${Math.floor((Date.now() - startTime) / 1000)}s`,
    lastCheck: lastCheckTime?.toISOString() || null,
    pairs: PAIRS.map(f => `USDT/${f}`),
    totalChecks,
    totalAlerts,
  });
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// ─── Start Everything ───────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  🚀 Wallet P2P Monitor Bot');
  console.log('═══════════════════════════════════════════');
  console.log(`  Pairs:    ${PAIRS.map(f => `USDT/${f}`).join(', ')} (КУПИТЬ)`);
  console.log(`  Interval: ${CHECK_INTERVAL}s`);
  for (const fiat of PAIRS) {
    const pc = pairConfigs[fiat];
    console.log(`  [${fiat}] Sell Thr: ${pc.sellThreshold || 'disabled'}`);
  }
  console.log('═══════════════════════════════════════════');

  // Start Express server
  app.listen(parseInt(PORT, 10), () => {
    console.log(`🌐 Keep-alive server on port ${PORT}`);
  });

  // Launch Telegram bot
  bot.launch();
  console.log('🤖 Telegram bot started');

  // Register commands menu
  try {
    await bot.telegram.setMyCommands([
      { command: 'status', description: '📊 Статус мониторинга' },
      { command: 'price', description: '🔎 Проверить цены сейчас' },
      { command: 'pause', description: '⏸ Приостановить мониторинг' },
      { command: 'resume', description: '▶️ Возобновить мониторинг' },
      { command: 'help', description: '📖 Справка' }
    ]);
    console.log('✅ Telegram bot commands menu registered');
  } catch (err) {
    console.error('⚠️ Failed to set commands:', err.message);
  }

  // Send startup notification
  const threshLines = PAIRS.map(fiat => {
    const pc = pairConfigs[fiat];
    return pc.sellThreshold ? `• ${fiat} КУПИТЬ: ${fmtPrice(pc.sellThreshold)}` : `• ${fiat} КУПИТЬ: порог не задан`;
  }).join('\n');

  await sendAlert(
    `🚀 *P2P Monitor запущен!*\n\n` +
    `• Пары: ${PAIRS.map(f => `USDT/${f}`).join(', ')} (КУПИТЬ)\n` +
    `• Интервал: ${CHECK_INTERVAL} сек\n` +
    `${threshLines}\n\n` +
    `Отправь /help для списка команд.`
  );

  // Start monitoring loop
  await checkPrices();
  checkTimer = setInterval(checkPrices, INTERVAL_MS);
}

// Graceful shutdown
process.once('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  clearInterval(checkTimer);
  bot.stop('SIGINT');
  process.exit(0);
});

process.once('SIGTERM', () => {
  console.log('\n🛑 Shutting down...');
  clearInterval(checkTimer);
  bot.stop('SIGTERM');
  process.exit(0);
});

main().catch((err) => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});

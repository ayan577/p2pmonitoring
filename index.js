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
  BUY:  ['yoomoney'],          // продаём USDT за рубли
};

function filterAdsByPayment(ads, fiatCurrency, side) {
  if (fiatCurrency !== 'RUB') return ads; // KZT — без фильтра
  const allowed = RUB_PAYMENTS_BY_SIDE[side] || [];
  return ads.filter((ad) =>
    (ad.payments || []).some((p) => allowed.includes(p.toLowerCase()))
  );
}

let pairConfigs = {
  KZT: {
    cryptoCurrency: CRYPTO_CURRENCY,
    fiatCurrency: 'KZT',
    side: 'BOTH',
    sellThreshold: SELL_THRESHOLD_KZT ? parseFloat(SELL_THRESHOLD_KZT) : null,
    buyThreshold: BUY_THRESHOLD_KZT ? parseFloat(BUY_THRESHOLD_KZT) : null,
    lastBestPrice: { SELL: null, BUY: null },
  },
  RUB: {
    cryptoCurrency: CRYPTO_CURRENCY,
    fiatCurrency: 'RUB',
    side: 'BOTH',
    sellThreshold: SELL_THRESHOLD_RUB ? parseFloat(SELL_THRESHOLD_RUB) : null,
    buyThreshold: BUY_THRESHOLD_RUB ? parseFloat(BUY_THRESHOLD_RUB) : null,
    lastBestPrice: { SELL: null, BUY: null },
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
      Markup.button.callback('💸 Порог ПРОДАТЬ KZT', 'set_thresh_buy_KZT'),
    ],
    [
      Markup.button.callback('🛒 Порог КУПИТЬ RUB', 'set_thresh_sell_RUB'),
      Markup.button.callback('💸 Порог ПРОДАТЬ RUB', 'set_thresh_buy_RUB'),
    ],
  ]);
}

// Reply keyboard — always visible, shown on /start
const mainKeyboard = Markup.keyboard([
  ['📊 Статус'],
  ['🛒 Порог КУПИТЬ KZT', '💸 Порог ПРОДАТЬ KZT'],
  ['🛒 Порог КУПИТЬ RUB', '💸 Порог ПРОДАТЬ RUB'],
]).resize();

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
      `• Порог ПРОДАТЬ: ${pc.buyThreshold ? fmtPrice(pc.buyThreshold) : 'не задан'}`,
      `• Цена SELL: ${pc.lastBestPrice.SELL !== null ? fmtPrice(pc.lastBestPrice.SELL) : '—'}`,
      `• Цена BUY: ${pc.lastBestPrice.BUY !== null ? fmtPrice(pc.lastBestPrice.BUY) : '—'}`,
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
  const rawAds = await fetchAds(pairConfig, side);

  if (rawAds === null) {
    console.log(`⚠️  [${new Date().toLocaleTimeString()}] API error for ${side} ${fiat}, retrying...`);
    return;
  }

  // Apply payment filter (RUB → only ЮMoney; KZT → all)
  const ads = filterAdsByPayment(rawAds, fiat, side);

  if (ads.length === 0) {
    console.log(`📭 [${new Date().toLocaleTimeString()}] No ads found for ${side} ${fiat}${fiat === 'RUB' ? ' (after ЮMoney filter)' : ''}`);
    return;
  }

  const analysis = analyzeAds(ads, side);
  if (!analysis) return;

  const { bestPrice } = analysis;
  console.log(`✅ [${lastCheckTime.toLocaleTimeString()}] ${fiat} ${side} Best: ${fmtPrice(bestPrice)} | Ads: ${analysis.totalAds}`);

  // Determine if we should send an alert
  let shouldAlert = false;
  const prevPrice = pairConfig.lastBestPrice[side];
  const threshold = side === 'SELL' ? pairConfig.sellThreshold : pairConfig.buyThreshold;

  if (threshold && bestPrice !== prevPrice) {
    if (side === 'SELL' && bestPrice <= threshold) {
      shouldAlert = true;
    } else if (side === 'BUY' && bestPrice >= threshold) {
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

  // Check all pairs
  for (const fiat of PAIRS) {
    const pc = pairConfigs[fiat];
    if (pc.side === 'BOTH') {
      await checkSidePrices(pc, 'SELL');
      await checkSidePrices(pc, 'BUY');
    } else {
      await checkSidePrices(pc, pc.side);
    }
  }
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
    `Я мониторю пары USDT/KZT и USDT/RUB.\n` +
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
    `/top — топ-5 лучших объявлений\n` +
    `/pause — остановить проверки\n` +
    `/resume — запустить проверки\n` +
    `/set\\_threshold <sell|buy> <kzt|rub> <цена> — установить порог\n\n` +
    `*Примеры:*\n` +
    `\`/set_threshold sell kzt 445\` — алерт, если цена покупки KZT <= 445\n` +
    `\`/set_threshold buy rub 95\` — алерт, если цена продажи RUB >= 95\n\n` +
    `*Мониторинг:*\n` +
    `• Пары: USDT/KZT и USDT/RUB\n` +
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
    for (const s of ['SELL', 'BUY']) {
      const rawAds = await fetchAds(pc, s);
      if (rawAds === null) {
        await ctx.reply(`❌ Ошибка API для ${s} ${fiat}. Попробуй позже.`);
        continue;
      }
      const ads = filterAdsByPayment(rawAds, fiat, s);
      if (ads.length === 0) {
        await ctx.reply(`📭 Объявлений не найдено для ${s} ${fiat}${fiat === 'RUB' ? ' (только ЮMoney)' : ''}.`);
        continue;
      }
      const analysis = analyzeAds(ads, s);
      await ctx.reply(buildAlertMessage(analysis, s, fiat), { parse_mode: 'Markdown' });
    }
  }
});

const topHandler = async (ctx) => {
  ctx.reply('🔍 Загружаю топ...');
  for (const fiat of PAIRS) {
    const pc = pairConfigs[fiat];
    for (const s of ['SELL', 'BUY']) {
      const rawAds = await fetchAds(pc, s, 1, 50);
      if (rawAds === null) {
        await ctx.reply(`❌ Ошибка API для ${s} ${fiat}.`);
        continue;
      }
      const ads = filterAdsByPayment(rawAds, fiat, s);
      if (ads.length === 0) {
        await ctx.reply(`📭 Объявлений не найдено для ${s} ${fiat}${fiat === 'RUB' ? ' (только ЮMoney)' : ''}.`);
        continue;
      }

      const sorted = [...ads].sort((a, b) => {
        const pa = parseFloat(a.price);
        const pb = parseFloat(b.price);
        return s === 'SELL' ? pa - pb : pb - pa;
      });
      const top5 = sorted.slice(0, 5);

      const lines = [
        `🏆 *Топ-5 предложений*`,
        `\`USDT/${fiat}\` | ${sideLabel(s)}`,
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
  }
};

bot.command('top', topHandler);

bot.command('pause', (ctx) => {
  if (!monitoring) return ctx.reply('⏸ Мониторинг уже приостановлен.');
  monitoring = false;
  ctx.reply('⏸ Мониторинг приостановлен. Отправь /resume чтобы продолжить.', mainInlineKeyboard());
});

bot.command('resume', (ctx) => {
  if (monitoring) return ctx.reply('✅ Мониторинг уже работает.');
  monitoring = true;
  // Reset prices
  for (const fiat of PAIRS) {
    pairConfigs[fiat].lastBestPrice = { SELL: null, BUY: null };
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
bot.action(/^set_thresh_(sell|buy)_(KZT|RUB)$/, async (ctx) => {
  const sideArg = ctx.match[1].toUpperCase(); // SELL or BUY
  const fiat = ctx.match[2]; // KZT or RUB
  const label = sideArg === 'SELL' ? 'КУПИТЬ' : 'ПРОДАТЬ';

  await ctx.answerCbQuery();
  waitingForThreshold = { side: sideArg, fiat };
  await ctx.reply(
    `Введите новую цену для порога ${label} (${fiat}).\n` +
    `Текущий порог: ${sideArg === 'SELL' ? (pairConfigs[fiat].sellThreshold ? fmtPrice(pairConfigs[fiat].sellThreshold) : 'не задан') : (pairConfigs[fiat].buyThreshold ? fmtPrice(pairConfigs[fiat].buyThreshold) : 'не задан')}`,
    Markup.forceReply()
  );
});

// ─── Reply Keyboard Handlers ────────────────────────────────

bot.hears('📊 Статус', (ctx) => {
  ctx.reply(buildStatusMessage(), { parse_mode: 'Markdown', ...mainInlineKeyboard() });
});


let waitingForThreshold = null; // { side: 'SELL'|'BUY', fiat: 'KZT'|'RUB' }

bot.hears('🛒 Порог КУПИТЬ KZT', (ctx) => {
  waitingForThreshold = { side: 'SELL', fiat: 'KZT' };
  ctx.reply(
    `Введите новую цену для порога КУПИТЬ (KZT).\nТекущий: ${pairConfigs.KZT.sellThreshold ? fmtPrice(pairConfigs.KZT.sellThreshold) : 'не задан'}`,
    Markup.forceReply()
  );
});

bot.hears('💸 Порог ПРОДАТЬ KZT', (ctx) => {
  waitingForThreshold = { side: 'BUY', fiat: 'KZT' };
  ctx.reply(
    `Введите новую цену для порога ПРОДАТЬ (KZT).\nТекущий: ${pairConfigs.KZT.buyThreshold ? fmtPrice(pairConfigs.KZT.buyThreshold) : 'не задан'}`,
    Markup.forceReply()
  );
});

bot.hears('🛒 Порог КУПИТЬ RUB', (ctx) => {
  waitingForThreshold = { side: 'SELL', fiat: 'RUB' };
  ctx.reply(
    `Введите новую цену для порога КУПИТЬ (RUB).\nТекущий: ${pairConfigs.RUB.sellThreshold ? fmtPrice(pairConfigs.RUB.sellThreshold) : 'не задан'}`,
    Markup.forceReply()
  );
});

bot.hears('💸 Порог ПРОДАТЬ RUB', (ctx) => {
  waitingForThreshold = { side: 'BUY', fiat: 'RUB' };
  ctx.reply(
    `Введите новую цену для порога ПРОДАТЬ (RUB).\nТекущий: ${pairConfigs.RUB.buyThreshold ? fmtPrice(pairConfigs.RUB.buyThreshold) : 'не задан'}`,
    Markup.forceReply()
  );
});

// Handle threshold text input
bot.on('text', (ctx, next) => {
  const text = ctx.message.text;

  // Ignore commands and known buttons
  if (text.startsWith('/') || [
    '📊 Статус',
    '🛒 Порог КУПИТЬ KZT', '💸 Порог ПРОДАТЬ KZT',
    '🛒 Порог КУПИТЬ RUB', '💸 Порог ПРОДАТЬ RUB',
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
        const isSell = replyText.includes('КУПИТЬ');
        const fiatMatch = replyText.match(/(KZT|RUB)/);
        threshInfo = {
          side: isSell ? 'SELL' : 'BUY',
          fiat: fiatMatch ? fiatMatch[1] : (waitingForThreshold?.fiat || 'KZT'),
        };
      }

      if (!threshInfo) threshInfo = { side: 'SELL', fiat: 'KZT' };

      const pc = pairConfigs[threshInfo.fiat];
      if (threshInfo.side === 'SELL') {
        pc.sellThreshold = val;
      } else {
        pc.buyThreshold = val;
      }

      waitingForThreshold = null;
      const label = threshInfo.side === 'SELL' ? 'КУПИТЬ' : 'ПРОДАТЬ';
      return ctx.reply(
        `✅ Порог ${label} (${threshInfo.fiat}) установлен: *${fmtPrice(val)} ${threshInfo.fiat}*`,
        { parse_mode: 'Markdown', ...mainInlineKeyboard() }
      );
    }
  }

  return next();
});

// /set_threshold <sell|buy> <kzt|rub> <price>
bot.command('set_threshold', (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 3) {
    return ctx.reply(
      '⚠️ Использование: `/set_threshold <sell|buy> <kzt|rub> <цена>`\n' +
      'Например: `/set_threshold sell kzt 445`',
      { parse_mode: 'Markdown' }
    );
  }

  const sideArg = args[0].toUpperCase();
  const fiat = args[1].toUpperCase();
  const val = parseFloat(args[2].replace(',', '.'));

  if (!['SELL', 'BUY'].includes(sideArg)) {
    return ctx.reply('❌ Укажите сторону: `sell` или `buy`', { parse_mode: 'Markdown' });
  }
  if (!PAIRS.includes(fiat)) {
    return ctx.reply('❌ Укажите валюту: `kzt` или `rub`', { parse_mode: 'Markdown' });
  }
  if (isNaN(val)) {
    return ctx.reply('❌ Введите корректное число (например: 490.50)');
  }

  const pc = pairConfigs[fiat];
  if (sideArg === 'SELL') {
    pc.sellThreshold = val;
  } else {
    pc.buyThreshold = val;
  }

  const label = sideArg === 'SELL' ? 'КУПИТЬ' : 'ПРОДАТЬ';
  ctx.reply(
    `🎯 Порог ${label} (${fiat}) установлен: *${fmtPrice(val)} ${fiat}*`,
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
  console.log(`  Pairs:    ${PAIRS.map(f => `USDT/${f}`).join(', ')}`);
  console.log(`  Interval: ${CHECK_INTERVAL}s`);
  for (const fiat of PAIRS) {
    const pc = pairConfigs[fiat];
    console.log(`  [${fiat}] Sell Thr: ${pc.sellThreshold || 'disabled'} | Buy Thr: ${pc.buyThreshold || 'disabled'}`);
  }
  console.log('═══════════════════════════════════════════');

  // Start Express server
  app.listen(parseInt(PORT, 10), () => {
    console.log(`🌐 Keep-alive server on port ${PORT}`);
  });

  // Launch Telegram bot
  bot.launch();
  console.log('🤖 Telegram bot started');

  // Send startup notification
  const threshLines = PAIRS.map(fiat => {
    const pc = pairConfigs[fiat];
    const parts = [];
    if (pc.sellThreshold) parts.push(`SELL: ${fmtPrice(pc.sellThreshold)}`);
    if (pc.buyThreshold) parts.push(`BUY: ${fmtPrice(pc.buyThreshold)}`);
    return parts.length ? `• ${fiat}: ${parts.join(' | ')}` : `• ${fiat}: пороги не заданы`;
  }).join('\n');

  await sendAlert(
    `🚀 *P2P Monitor запущен!*\n\n` +
    `• Пары: ${PAIRS.map(f => `USDT/${f}`).join(', ')}\n` +
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

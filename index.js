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
  FIAT_CURRENCY = 'KZT',
  SIDE = 'BOTH', // Default changed to BOTH to reflect new features
  SELL_THRESHOLD = '',
  BUY_THRESHOLD = '',
  PORT = '3000',
} = process.env;

// Validate required env vars
if (!BOT_TOKEN || !CHAT_ID || !WALLET_API_KEY) {
  console.error('❌ Missing required env vars: BOT_TOKEN, CHAT_ID, WALLET_API_KEY');
  process.exit(1);
}

const INTERVAL_MS = parseInt(CHECK_INTERVAL, 10) * 1000;
const parsedSellThreshold = SELL_THRESHOLD ? parseFloat(SELL_THRESHOLD) : null;
const parsedBuyThreshold = BUY_THRESHOLD ? parseFloat(BUY_THRESHOLD) : null;

// ─── State ──────────────────────────────────────────────────
let monitoring = true;          // Is monitoring active?
let lastBestPrice = { SELL: null, BUY: null };  // Previous best prices per side
let lastCheckTime = null;       // Last successful check timestamp
let totalChecks = 0;            // Total checks performed
let totalAlerts = 0;            // Total alerts sent
let checkTimer = null;          // Interval timer reference

// Current monitoring config (can be changed via bot commands)
let config = {
  cryptoCurrency: CRYPTO_CURRENCY,
  fiatCurrency: FIAT_CURRENCY,
  side: SIDE, // Can be 'SELL', 'BUY', or 'BOTH'
  alertMode: 'ALL', // 'ALL' or 'THRESHOLD'
  sellThreshold: parsedSellThreshold,
  buyThreshold: parsedBuyThreshold,
};

// ─── Wallet P2P API ─────────────────────────────────────────
const API_URL = 'https://p2p.walletbot.me/p2p/integration-api/v1/item/online';

async function fetchAds(sideToFetch, page = 1, pageSize = 20) {
  try {
    const response = await axios.post(API_URL, {
      cryptoCurrency: config.cryptoCurrency,
      fiatCurrency: config.fiatCurrency,
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
    return null; // null = error, [] = empty results
  }
}

// ─── Price Analysis ─────────────────────────────────────────
function analyzeAds(ads, sideToFetch) {
  if (!ads || ads.length === 0) return null;

  const prices = ads.map((ad) => parseFloat(ad.price));
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  
  // For SELL ads (we are buying crypto), we want the lowest price
  // For BUY ads (we want to sell crypto to them), we want the highest price!
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

// Build a status message
function buildStatusMessage() {
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const mins = Math.floor((uptime % 3600) / 60);

  return [
    `📊 *Статус мониторинга*`,
    ``,
    `• Состояние: ${monitoring ? '✅ Активен' : '⏸ Приостановлен'}`,
    `• Пара: \`${config.cryptoCurrency}/${config.fiatCurrency}\``,
    `• Направление: ${sideLabel(config.side)}`,
    `• Режим алертов: ${config.alertMode === 'ALL' ? 'ВСЕ изменения' : 'ТОЛЬКО по порогу'}`,
    config.sellThreshold ? `• Порог КУПИТЬ: ${fmtPrice(config.sellThreshold)}` : `• Порог КУПИТЬ: не задан`,
    config.buyThreshold ? `• Порог ПРОДАТЬ: ${fmtPrice(config.buyThreshold)}` : `• Порог ПРОДАТЬ: не задан`,
    ``,
    `📈 *Статистика*`,
    `• Проверок: ${totalChecks}`,
    `• Алертов: ${totalAlerts}`,
    `• Актуальная цена SELL: ${lastBestPrice.SELL !== null ? fmtPrice(lastBestPrice.SELL) : '—'}`,
    `• Актуальная цена BUY: ${lastBestPrice.BUY !== null ? fmtPrice(lastBestPrice.BUY) : '—'}`,
    `• Последняя проверка: ${lastCheckTime ? lastCheckTime.toLocaleTimeString('ru-RU') : '—'}`,
    `• Аптайм: ${hours}ч ${mins}м`,
  ].join('\n');
}

// Build price alert message
function buildAlertMessage(analysis, reason, side) {
  const { bestPrice, totalAds, bestAd } = analysis;
  const sideTitle = side === 'SELL' ? 'ВЫ МОЖЕТЕ КУПИТЬ' : 'ВЫ МОЖЕТЕ ПРОДАТЬ';

  const lines = [
    `🔔 *${sideTitle}*`,
    ``,
    `💰 *Цена:* \`${fmtPrice(bestPrice)} ${config.fiatCurrency}\``,
  ];

  if (bestAd) {
    lines.push(
      ``,
      `👤 *Продавец:* ${bestAd.nickname || '—'}`,
      `💳 *Оплата:* ${(bestAd.payments || []).join(', ') || '—'}`,
      `📏 *Лимит:* ${fmtPrice(bestAd.minAmount)}–${fmtPrice(bestAd.maxAmount)} ${config.fiatCurrency}`
    );
  }

  const prevPrice = lastBestPrice[side];
  if (prevPrice !== null && bestPrice !== prevPrice) {
    const diff = bestPrice - prevPrice;
    const arrow = diff > 0 ? '📈' : diff < 0 ? '📉' : '➡️';
    lines.push(``, `${arrow} Изменение: ${diff > 0 ? '+' : ''}${fmtPrice(diff)} ${config.fiatCurrency}`);
  }

  lines.push(
    ``,
    `*Причина:* ${reason}`,
    `🕐 ${new Date().toLocaleTimeString('ru-RU')} | Объявлений: ${totalAds}`
  );

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
async function checkSidePrices(side) {
  const ads = await fetchAds(side);

  // API error — skip this round
  if (ads === null) {
    console.log(`⚠️  [${new Date().toLocaleTimeString()}] API error for ${side}, retrying...`);
    return;
  }

  // No ads available
  if (ads.length === 0) {
    console.log(`📭 [${new Date().toLocaleTimeString()}] No ads found for ${side}`);
    return;
  }

  const analysis = analyzeAds(ads, side);
  if (!analysis) return;

  const { bestPrice } = analysis;
  console.log(`✅ [${lastCheckTime.toLocaleTimeString()}] ${side} Best: ${fmtPrice(bestPrice)} ${config.fiatCurrency} | Ads: ${analysis.totalAds}`);

  // Determine if we should send an alert
  let shouldAlert = false;
  let reason = '';
  const prevPrice = lastBestPrice[side];
  const threshold = side === 'SELL' ? config.sellThreshold : config.buyThreshold;

  // 1. First check — always notify
  if (prevPrice === null) {
    shouldAlert = true;
    reason = 'Мониторинг запущен';
  } else if (config.alertMode === 'ALL') {
    // 2. Alert on any significant change (>= 0.5%)
    if (bestPrice !== prevPrice) {
      const diff = Math.abs(bestPrice - prevPrice);
      const percentChange = (diff / prevPrice) * 100;
      if (percentChange >= 0.5) {
        shouldAlert = true;
        reason = bestPrice < prevPrice ? 'Цена упала! 📉' : 'Цена выросла 📈';
      }
    }
    // Also alert if it hit threshold
    if (threshold) {
      if (side === 'SELL' && bestPrice <= threshold && prevPrice > threshold) {
        shouldAlert = true;
        reason = `Цена упала до порога ${fmtPrice(threshold)}`;
      } else if (side === 'BUY' && bestPrice >= threshold && prevPrice < threshold) {
        shouldAlert = true;
        reason = `Цена поднялась до порога ${fmtPrice(threshold)}`;
      }
    }
  } else if (config.alertMode === 'THRESHOLD') {
    // 3. Threshold mode - only alert if hits threshold and changed
    if (threshold && bestPrice !== prevPrice) {
      if (side === 'SELL' && bestPrice <= threshold) {
        shouldAlert = true;
        reason = `ДОСТИГНУТ ПОРОГ ${threshold}`;
      } else if (side === 'BUY' && bestPrice >= threshold) {
        shouldAlert = true;
        reason = `ДОСТИГНУТ ПОРОГ ${threshold}`;
      }
    }
  }

  if (shouldAlert) {
    await sendAlert(buildAlertMessage(analysis, reason, side));
  }

  lastBestPrice[side] = bestPrice;
}

async function checkPrices() {
  if (!monitoring) return;

  totalChecks++;
  lastCheckTime = new Date();

  if (config.side === 'BOTH') {
    await checkSidePrices('SELL');
    await checkSidePrices('BUY');
  } else {
    await checkSidePrices(config.side);
  }
}

// ─── Bot Commands ───────────────────────────────────────────

// Security middleware — only allow configured CHAT_ID
bot.use((ctx, next) => {
  if (String(ctx.from?.id) !== String(CHAT_ID)) {
    return ctx.reply('⛔ Доступ запрещён');
  }
  return next();
});

const mainKeyboard = Markup.keyboard([
  ['📊 Статус', '🔍 Топ-5'],
  ['🛒 Порог КУПИТЬ', '💸 Порог ПРОДАТЬ']
]).resize();

bot.command('start', (ctx) => {
  ctx.reply(
    `👋 *Привет! Я P2P Monitor Bot*\n\n` +
    `Я помогаю следить за рынком.\n` +
    `Для навигации используйте кнопки ниже 👇`,
    mainKeyboard
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
    `/mode <all|threshold> — переключить режим\n` +
    `/set\\_threshold <sell|buy> <цена> — установить порог\n` +
    `/set\\_pair <crypto> <fiat> <side> — сменить пару\n\n` +
    `*Примеры:*\n` +
    `\`/set_pair USDT KZT BOTH\` — мониторить и покупку, и продажу\n` +
    `\`/set_threshold sell 445\` — алерт, если покупка с рынка падает <= 445\n` +
    `\`/set_threshold buy 500\` — алерт на трэш-заявки по продаже на рынке >= 500\n\n` +
    `*Как работают алерты:*\n` +
    `• Бот проверяет лучшую цену каждые ${CHECK_INTERVAL} сек\n` +
    `• Режим ALL: Алерт при изменении цены ≥ 0.5% и при пересечении порогов\n` +
    `• Режим THRESHOLD: Только срабатывание порогов`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('status', (ctx) => {
  ctx.reply(buildStatusMessage(), { parse_mode: 'Markdown' });
});

bot.command('price', async (ctx) => {
  ctx.reply('🔍 Проверяю...');
  const sides = config.side === 'BOTH' ? ['SELL', 'BUY'] : [config.side];
  for (const s of sides) {
    const ads = await fetchAds(s);
    if (ads === null) {
      await ctx.reply(`❌ Ошибка API для ${s}. Попробуй позже.`);
      continue;
    }
    if (ads.length === 0) {
      await ctx.reply(`📭 Объявлений не найдено для ${s}.`);
      continue;
    }
    const analysis = analyzeAds(ads, s);
    await ctx.reply(buildAlertMessage(analysis, `Ручная проверка`, s), { parse_mode: 'Markdown', ...mainKeyboard });
  }
});

const topHandler = async (ctx) => {
  ctx.reply('🔍 Загружаю топ...');
  const sides = config.side === 'BOTH' ? ['SELL', 'BUY'] : [config.side];
  for (const s of sides) {
    const ads = await fetchAds(s, 1, 50);
    if (ads === null) {
      await ctx.reply(`❌ Ошибка API для ${s}.`, { ...mainKeyboard });
      continue;
    }
    if (ads.length === 0) {
      await ctx.reply(`📭 Объявлений не найдено для ${s}.`, { ...mainKeyboard });
      continue;
    }

    // Sort: SELL (we buy) -> ascending (best is cheapest)
    // BUY (we sell) -> descending (best is highest)
    const sorted = [...ads].sort((a, b) => {
      const pa = parseFloat(a.price);
      const pb = parseFloat(b.price);
      return s === 'SELL' ? pa - pb : pb - pa;
    });
    const top5 = sorted.slice(0, 5);

    const lines = [
      `🏆 *Топ-5 предложений*`,
      `\`${config.cryptoCurrency}/${config.fiatCurrency}\` | ${sideLabel(s)}`,
      ``,
    ];

    top5.forEach((ad, i) => {
      const medal = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'][i];
      const rate = ad.executeRate ? (parseFloat(ad.executeRate) * 100).toFixed(1) + '%' : '—';
      lines.push(
        `${medal} *${fmtPrice(ad.price)} ${config.fiatCurrency}*`,
        `   👤 ${ad.nickname || '—'} | ⭐ ${rate} | 📦 ${ad.orderNum || 0} сделок`,
        `   💳 ${(ad.payments || []).join(', ') || '—'}`,
        `   📏 ${fmtPrice(ad.minAmount)}–${fmtPrice(ad.maxAmount)} ${config.fiatCurrency}`,
        ``,
      );
    });

    lines.push(`📊 Всего объявлений: ${ads.length}`);
    lines.push(`🕐 ${new Date().toLocaleTimeString('ru-RU')}`);

    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown', ...mainKeyboard });
  }
};

bot.command('top', topHandler);

bot.command('pause', (ctx) => {
  if (!monitoring) return ctx.reply('⏸ Мониторинг уже приостановлен.');
  monitoring = false;
  ctx.reply('⏸ Мониторинг приостановлен. Отправь /resume чтобы продолжить.');
});

bot.command('resume', (ctx) => {
  if (monitoring) return ctx.reply('✅ Мониторинг уже работает.');
  monitoring = true;
  lastBestPrice = { SELL: null, BUY: null }; // Reset to get fresh baseline
  ctx.reply('▶️ Мониторинг возобновлён! Следующая проверка через несколько секунд...');
  checkPrices(); // Immediate check
});

bot.command('mode', (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length === 0) {
    return ctx.reply(
      `⚙️ Текущий режим: *${config.alertMode}*\n\n` +
      `Используй: \`/mode all\` или \`/mode threshold\``,
      { parse_mode: 'Markdown' }
    );
  }
  
  const m = args[0].toUpperCase();
  if (m === 'ALL' || m === 'THRESHOLD') {
    config.alertMode = m;
    ctx.reply(`✅ Режим алертов изменён на: *${m}*`, { parse_mode: 'Markdown' });
  } else {
    ctx.reply('❌ Неизвестный режим. Используй `all` или `threshold`.');
  }
});

// Reply Keyboard interactions
bot.hears('📊 Статус', (ctx) => {
  ctx.reply(buildStatusMessage(), { parse_mode: 'Markdown' });
});

bot.hears('🔍 Топ-5', topHandler);

let waitingForThreshold = null; // 'SELL' or 'BUY'

bot.hears('🛒 Порог КУПИТЬ', (ctx) => {
  waitingForThreshold = 'SELL';
  ctx.reply('Введите новую цену для порога КУПИТЬ (алерт будет, если цена ниже или равна этой):', Markup.forceReply());
});

bot.hears('💸 Порог ПРОДАТЬ', (ctx) => {
  waitingForThreshold = 'BUY';
  ctx.reply('Введите новую цену для порога ПРОДАТЬ (алерт будет, если цена выше или равна этой):', Markup.forceReply());
});

bot.on('text', (ctx, next) => {
  const text = ctx.message.text;

  // Ignore commands and standard buttons
  if (text.startsWith('/') || ['📊 Статус', '🔍 Топ-5', '🛒 Порог КУПИТЬ', '💸 Порог ПРОДАТЬ'].includes(text)) {
    return next();
  }

  const isReply = ctx.message.reply_to_message && ctx.message.reply_to_message.text && ctx.message.reply_to_message.text.includes('Введите новую цену для порога');
  if (isReply || waitingForThreshold) {
    const val = parseFloat(text.replace(',', '.'));
    if (!isNaN(val)) {
      let side = waitingForThreshold;
      if (isReply) {
        side = ctx.message.reply_to_message.text.includes('КУПИТЬ') ? 'SELL' : 'BUY';
      }
      if (!side) side = 'SELL';

      if (side === 'SELL') {
        config.sellThreshold = val;
      } else {
        config.buyThreshold = val;
      }
      waitingForThreshold = null;
      return ctx.reply(`✅ Порог для ${side === 'SELL' ? 'КУПИТЬ' : 'ПРОДАТЬ'} установлен на: *${fmtPrice(val)} ${config.fiatCurrency}*`, { parse_mode: 'Markdown' });
    }
  }

  return next();
});

bot.command('set_threshold', (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 2) {
    return ctx.reply('⚠️ Использование: `/set_threshold <sell|buy> 490`\nНапример: `/set_threshold buy 500`', { parse_mode: 'Markdown' });
  }
  
  const sideArg = args[0].toUpperCase();
  if (!['SELL', 'BUY'].includes(sideArg)) {
      return ctx.reply('❌ Укажите сторону `sell` или `buy`.');
  }

  const val = parseFloat(args[1].replace(',', '.'));
  if (isNaN(val)) {
    return ctx.reply('❌ Пожалуйста, введи корректное число (например: 490.50)');
  }
  
  if (sideArg === 'SELL') {
      config.sellThreshold = val;
  } else {
      config.buyThreshold = val;
  }
  
  ctx.reply(`🎯 Порог для ${sideArg} установлен на: *${fmtPrice(val)} ${config.fiatCurrency}*`, { parse_mode: 'Markdown' });
});

bot.command('set_pair', (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 3) {
    return ctx.reply(
      '⚠️ Использование: `/set_pair CRYPTO FIAT SIDE`\n' +
      'Пример: `/set_pair USDT KZT BOTH`',
      { parse_mode: 'Markdown' }
    );
  }

  const [crypto, fiat, side] = args.map((a) => a.toUpperCase());

  if (!['BUY', 'SELL', 'BOTH'].includes(side)) {
    return ctx.reply('❌ SIDE должен быть BUY, SELL или BOTH');
  }

  config.cryptoCurrency = crypto;
  config.fiatCurrency = fiat;
  config.side = side;
  lastBestPrice = { SELL: null, BUY: null }; // Reset

  ctx.reply(
    `✅ Пара изменена!\n\n` +
    `• Крипта: \`${crypto}\`\n` +
    `• Фиат: \`${fiat}\`\n` +
    `• Направление: ${sideLabel(side)}\n\n` +
    `Мониторинг продолжается с новой парой.`,
    { parse_mode: 'Markdown' }
  );

  checkPrices(); // Immediate check with new pair
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
    pair: `${config.cryptoCurrency}/${config.fiatCurrency}`,
    side: config.side,
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
  console.log(`  Pair:     ${config.cryptoCurrency}/${config.fiatCurrency}`);
  console.log(`  Side:     ${config.side}`);
  console.log(`  Interval: ${CHECK_INTERVAL}s`);
  console.log(`  Sell Thr: ${config.sellThreshold || 'disabled'}`);
  console.log(`  Buy Thr : ${config.buyThreshold || 'disabled'}`);
  console.log('═══════════════════════════════════════════');

  // Start Express server
  app.listen(parseInt(PORT, 10), () => {
    console.log(`🌐 Keep-alive server on port ${PORT}`);
  });

  // Launch Telegram bot
  bot.launch();
  console.log('🤖 Telegram bot started');

  // Send startup notification
  await sendAlert(
    `🚀 *P2P Monitor запущен!*\n\n` +
    `• Пара: \`${config.cryptoCurrency}/${config.fiatCurrency}\`\n` +
    `• Направление: ${sideLabel(config.side)}\n` +
    `• Интервал: ${CHECK_INTERVAL} сек\n` +
    `• Режим: ${config.alertMode}\n` +
    (config.sellThreshold ? `• Порог SELL: ${fmtPrice(config.sellThreshold)} ${config.fiatCurrency}\n` : '') +
    (config.buyThreshold ? `• Порог BUY (трэш): ${fmtPrice(config.buyThreshold)} ${config.fiatCurrency}\n` : '') +
    `\nОтправь /help для списка команд.`
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

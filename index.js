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
  SIDE = 'SELL',
  PRICE_THRESHOLD = '',
  PORT = '3000',
} = process.env;

// Validate required env vars
if (!BOT_TOKEN || !CHAT_ID || !WALLET_API_KEY) {
  console.error('❌ Missing required env vars: BOT_TOKEN, CHAT_ID, WALLET_API_KEY');
  process.exit(1);
}

const INTERVAL_MS = parseInt(CHECK_INTERVAL, 10) * 1000;
const THRESHOLD = PRICE_THRESHOLD ? parseFloat(PRICE_THRESHOLD) : null;

// ─── State ──────────────────────────────────────────────────
let monitoring = true;          // Is monitoring active?
let lastBestPrice = null;       // Previous best price
let lastCheckTime = null;       // Last successful check timestamp
let totalChecks = 0;            // Total checks performed
let totalAlerts = 0;            // Total alerts sent
let checkTimer = null;          // Interval timer reference

// Current monitoring config (can be changed via bot commands)
let config = {
  cryptoCurrency: CRYPTO_CURRENCY,
  fiatCurrency: FIAT_CURRENCY,
  side: SIDE,
  alertMode: 'ALL', // 'ALL' or 'THRESHOLD'
  thresholdValue: THRESHOLD,
};

// ─── Wallet P2P API ─────────────────────────────────────────
const API_URL = 'https://p2p.walletbot.me/p2p/integration-api/v1/item/online';

async function fetchAds(page = 1, pageSize = 20) {
  try {
    const response = await axios.post(API_URL, {
      cryptoCurrency: config.cryptoCurrency,
      fiatCurrency: config.fiatCurrency,
      side: config.side,
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
function analyzeAds(ads) {
  if (!ads || ads.length === 0) return null;

  const prices = ads.map((ad) => parseFloat(ad.price));
  const bestPrice = Math.min(...prices);
  const worstPrice = Math.max(...prices);
  const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;

  // Find the best ad (lowest price for SELL side = cheapest to buy)
  const bestAd = ads.find((ad) => parseFloat(ad.price) === bestPrice);

  return {
    bestPrice,
    worstPrice,
    avgPrice: Math.round(avgPrice * 100) / 100,
    spread: Math.round((worstPrice - bestPrice) * 100) / 100,
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
  return side === 'SELL' ? '🔴 Продажа' : '🟢 Покупка';
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
    `• Интервал: каждые ${CHECK_INTERVAL} сек`,
    `• Режим алертов: ${config.alertMode === 'ALL' ? 'ВССЕ изменения' : 'ТОЛЬКО ниже порога'}`,
    config.thresholdValue ? `• Порог: ${fmtPrice(config.thresholdValue)} ${config.fiatCurrency}` : `• Порог: не задан`,
    ``,
    `📈 *Статистика*`,
    `• Проверок: ${totalChecks}`,
    `• Алертов: ${totalAlerts}`,
    `• Последняя цена: ${lastBestPrice ? fmtPrice(lastBestPrice) : '—'}`,
    `• Последняя проверка: ${lastCheckTime ? lastCheckTime.toLocaleTimeString('ru-RU') : '—'}`,
    `• Аптайм: ${hours}ч ${mins}м`,
  ].join('\n');
}

// Build price alert message
function buildAlertMessage(analysis, reason) {
  const { bestPrice, worstPrice, avgPrice, spread, totalAds, bestAd } = analysis;

  const lines = [
    `🔔 *P2P Алерт — ${reason}*`,
    ``,
    `💰 *Лучшая цена:* \`${fmtPrice(bestPrice)} ${config.fiatCurrency}\``,
    `📉 Средняя: ${fmtPrice(avgPrice)} | Макс: ${fmtPrice(worstPrice)}`,
    `📏 Спред: ${fmtPrice(spread)} ${config.fiatCurrency}`,
    `📦 Объявлений: ${totalAds}`,
    ``,
  ];

  if (bestAd) {
    lines.push(
      `👤 *Лучшее предложение:*`,
      `• Ник: ${bestAd.nickname || '—'}`,
      `• Лимит: ${fmtPrice(bestAd.minAmount)}–${fmtPrice(bestAd.maxAmount)} ${config.fiatCurrency}`,
      `• Оплата: ${(bestAd.payments || []).join(', ') || '—'}`,
      `• Рейтинг: ${bestAd.executeRate ? (parseFloat(bestAd.executeRate) * 100).toFixed(1) + '%' : '—'}`,
      `• Сделок: ${bestAd.orderNum || '—'}`,
      `• Статус: ${bestAd.merchantLevel || '—'} ${bestAd.isOnline ? '🟢' : '⚪️'}`,
      ``,
    );
  }

  if (lastBestPrice !== null) {
    const diff = bestPrice - lastBestPrice;
    const arrow = diff > 0 ? '📈' : diff < 0 ? '📉' : '➡️';
    lines.push(`${arrow} Изменение: ${diff > 0 ? '+' : ''}${fmtPrice(diff)} ${config.fiatCurrency}`);
  }

  lines.push(`\n🕐 ${new Date().toLocaleTimeString('ru-RU')} | \`${config.cryptoCurrency}/${config.fiatCurrency}\` ${sideLabel(config.side)}`);

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
async function checkPrices() {
  if (!monitoring) return;

  const ads = await fetchAds();

  // API error — skip this round
  if (ads === null) {
    console.log(`⚠️  [${new Date().toLocaleTimeString()}] API error, retrying next interval...`);
    return;
  }

  // No ads available
  if (ads.length === 0) {
    console.log(`📭 [${new Date().toLocaleTimeString()}] No ads found for ${config.cryptoCurrency}/${config.fiatCurrency} ${config.side}`);
    return;
  }

  totalChecks++;
  lastCheckTime = new Date();

  const analysis = analyzeAds(ads);
  if (!analysis) return;

  const { bestPrice } = analysis;
  console.log(`✅ [${lastCheckTime.toLocaleTimeString()}] Best: ${fmtPrice(bestPrice)} ${config.fiatCurrency} | Ads: ${analysis.totalAds} | Avg: ${fmtPrice(analysis.avgPrice)}`);

  // Determine if we should send an alert
  let shouldAlert = false;
  let reason = '';

  // 1. First check — always notify
  if (lastBestPrice === null) {
    shouldAlert = true;
    reason = 'Мониторинг запущен';
  } else if (config.alertMode === 'ALL') {
    // 2. Alert on any significant change (>= 0.5%)
    if (bestPrice !== lastBestPrice) {
      const diff = Math.abs(bestPrice - lastBestPrice);
      const percentChange = (diff / lastBestPrice) * 100;
      if (percentChange >= 0.5) {
        shouldAlert = true;
        reason = bestPrice < lastBestPrice ? 'Цена упала! 📉' : 'Цена выросла 📈';
      }
    }
    // Also alert if it hit threshold
    if (config.thresholdValue && bestPrice <= config.thresholdValue && lastBestPrice > config.thresholdValue) {
      shouldAlert = true;
      reason = `🎯 Цена у порога ${fmtPrice(config.thresholdValue)}!`;
    }
  } else if (config.alertMode === 'THRESHOLD') {
    // 3. Threshold mode - only alert if below threshold and changed
    if (config.thresholdValue && bestPrice <= config.thresholdValue && bestPrice !== lastBestPrice) {
      shouldAlert = true;
      reason = `🎯 Цена ниже порога: ${fmtPrice(bestPrice)}!`;
    }
  }

  if (shouldAlert) {
    await sendAlert(buildAlertMessage(analysis, reason));
  }

  lastBestPrice = bestPrice;
}

// ─── Bot Commands ───────────────────────────────────────────

// Security middleware — only allow configured CHAT_ID
bot.use((ctx, next) => {
  if (String(ctx.from?.id) !== String(CHAT_ID)) {
    return ctx.reply('⛔ Доступ запрещён');
  }
  return next();
});

bot.command('start', (ctx) => {
  ctx.reply(
    `👋 *Привет! Я P2P Monitor Bot*\n\n` +
    `Слежу за ценами на Wallet P2P маркете и шлю алерты.\n\n` +
    `Доступные команды:\n` +
    `/status — текущий статус\n` +
    `/price — проверить цену сейчас\n` +
    `/top — топ-5 лучших предложений\n` +
    `/pause — приостановить мониторинг\n` +
    `/resume — возобновить мониторинг\n` +
    `/mode <all|threshold> — режим алертов\n` +
    `/set\\_threshold <цена> — задать порог\n` +
    `/set\\_pair USDT KZT SELL — сменить пару\n` +
    `/help — справка`,
    { parse_mode: 'Markdown' }
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
    `/set\\_threshold <цена> — установить порог\n` +
    `/set\\_pair <crypto> <fiat> <side> — сменить пару\n\n` +
    `*Примеры:*\n` +
    `\`/set_pair USDT KZT SELL\` — продажа USDT за тенге\n` +
    `\`/set_pair BTC RUB BUY\` — покупка BTC за рубли\n` +
    `\`/set_pair USDT USD SELL\` — продажа USDT за доллары\n\n` +
    `*Как работают алерты:*\n` +
    `• Бот проверяет лучшую цену каждые ${CHECK_INTERVAL} сек\n` +
    `• Алерт при изменении цены ≥ 0.5%\n` +
    (THRESHOLD ? `• Алерт при падении цены ниже ${fmtPrice(THRESHOLD)}\n` : '') +
    `• Первая проверка — всегда алерт`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('status', (ctx) => {
  ctx.reply(buildStatusMessage(), { parse_mode: 'Markdown' });
});

bot.command('price', async (ctx) => {
  ctx.reply('🔍 Проверяю...');
  const ads = await fetchAds();

  if (ads === null) return ctx.reply('❌ Ошибка API. Попробуй позже.');
  if (ads.length === 0) return ctx.reply('📭 Объявлений не найдено.');

  const analysis = analyzeAds(ads);
  await ctx.reply(buildAlertMessage(analysis, 'Ручная проверка'), { parse_mode: 'Markdown' });
});

bot.command('top', async (ctx) => {
  ctx.reply('🔍 Загружаю топ...');
  const ads = await fetchAds(1, 50);

  if (ads === null) return ctx.reply('❌ Ошибка API.');
  if (ads.length === 0) return ctx.reply('📭 Объявлений не найдено.');

  // Sort by price ascending
  const sorted = [...ads].sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
  const top5 = sorted.slice(0, 5);

  const lines = [
    `🏆 *Топ-5 предложений*`,
    `\`${config.cryptoCurrency}/${config.fiatCurrency}\` | ${sideLabel(config.side)}`,
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

  await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
});

bot.command('pause', (ctx) => {
  if (!monitoring) return ctx.reply('⏸ Мониторинг уже приостановлен.');
  monitoring = false;
  ctx.reply('⏸ Мониторинг приостановлен. Отправь /resume чтобы продолжить.');
});

bot.command('resume', (ctx) => {
  if (monitoring) return ctx.reply('✅ Мониторинг уже работает.');
  monitoring = true;
  lastBestPrice = null; // Reset to get fresh baseline
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

bot.command('set_threshold', (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length === 0) {
    return ctx.reply('⚠️ Использование: `/set_threshold 490` (число)', { parse_mode: 'Markdown' });
  }
  
  const val = parseFloat(args[0].replace(',', '.'));
  if (isNaN(val)) {
    return ctx.reply('❌ Пожалуйста, введи корректное число (например: 490.50)');
  }
  
  config.thresholdValue = val;
  ctx.reply(`🎯 Текущий порог цены установлен на: *${fmtPrice(val)} ${config.fiatCurrency}*`, { parse_mode: 'Markdown' });
});

bot.command('set_pair', (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 3) {
    return ctx.reply(
      '⚠️ Использование: `/set_pair CRYPTO FIAT SIDE`\n' +
      'Пример: `/set_pair USDT KZT SELL`',
      { parse_mode: 'Markdown' }
    );
  }

  const [crypto, fiat, side] = args.map((a) => a.toUpperCase());

  if (!['BUY', 'SELL'].includes(side)) {
    return ctx.reply('❌ SIDE должен быть BUY или SELL');
  }

  config.cryptoCurrency = crypto;
  config.fiatCurrency = fiat;
  config.side = side;
  lastBestPrice = null; // Reset

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
  console.log(`  Threshold: ${THRESHOLD || 'disabled'}`);
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
    (config.thresholdValue ? `• Порог: ${fmtPrice(config.thresholdValue)} ${config.fiatCurrency}\n` : '') +
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

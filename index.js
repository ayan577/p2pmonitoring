// ============================================================
//  P2P Monitoring Bot (Wallet + Bybit)
//  Мониторит цену покупки USDT/KZT на двух P2P площадках
//  и шлёт алерты в Telegram при достижении порога
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
  MIN_LIMIT_KZT = '',
  MAX_LIMIT_KZT = '',
  PORT = '3000',
} = process.env;

// Validate required env vars
if (!BOT_TOKEN || !CHAT_ID || !WALLET_API_KEY) {
  console.error('❌ Missing required env vars: BOT_TOKEN, CHAT_ID, WALLET_API_KEY');
  process.exit(1);
}

// Guard against CHECK_INTERVAL=0/garbage → would otherwise setInterval at ~0ms and hammer the API
const INTERVAL_SECONDS = parseInt(CHECK_INTERVAL, 10);
const INTERVAL_MS = (Number.isFinite(INTERVAL_SECONDS) && INTERVAL_SECONDS > 0 ? INTERVAL_SECONDS : 30) * 1000;

// ─── Pair & threshold (RUB полностью удалён) ────────────────
const FIAT = 'KZT'; // единственная пара USDT/KZT, только покупка USDT
const CRYPTO = CRYPTO_CURRENCY;
let sellThreshold = SELL_THRESHOLD_KZT ? parseFloat(SELL_THRESHOLD_KZT) : null;
// Фильтр по лимитам объявления (KZT): учитываются только объявления, чей диапазон
// сумм [minAmount, maxAmount] пересекается с заданным [minLimit, maxLimit].
// Например, при MAX_LIMIT_KZT=500000 объявление «1 000 000–5 000 000» не попадёт
// ни в цены, ни в /top, ни в алерты — его нельзя купить в пределах бюджета.
function parseLimit(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) && n >= 0 ? n : null; // мусор/NaN → null (без фильтра)
}
let minLimit = parseLimit(MIN_LIMIT_KZT);
let maxLimit = parseLimit(MAX_LIMIT_KZT);

// ─── Platforms ──────────────────────────────────────────────
// У каждой площадки свой lastBestPrice и свои алерты по общему порогу.
const PLATFORM_IDS = ['WALLET', 'BYBIT'];
const platforms = {
  WALLET: { id: 'WALLET', name: 'Wallet', lastBestPrice: { SELL: null } },
  BYBIT:  { id: 'BYBIT',  name: 'Bybit',  lastBestPrice: { SELL: null } },
};
const fetcherFor = (id) => (id === 'BYBIT' ? fetchBybitAds : fetchWalletAds);

// ─── State ──────────────────────────────────────────────────
let monitoring = true;
let lastCheckTime = null;
let totalChecks = 0;
let totalAlerts = 0;
let checkTimer = null;
let checkInProgress = false; // re-entrancy guard for checkPrices()
let waitingForThreshold = null; // { side: 'SELL', fiat: 'KZT' }

// ─── Wallet P2P API ─────────────────────────────────────────
const WALLET_API_URL = 'https://p2p.walletbot.me/p2p/integration-api/v1/item/online';

async function fetchWalletAds(sideToFetch, page = 1, pageSize = 50) {
  try {
    const response = await axios.post(WALLET_API_URL, {
      cryptoCurrency: CRYPTO,
      fiatCurrency: FIAT,
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

    console.warn('⚠️  Wallet API returned non-SUCCESS status:', response.data?.status);
    return [];
  } catch (error) {
    const msg = error.response
      ? `HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`
      : error.message;
    console.error('❌ Wallet API Error:', msg);
    return null;
  }
}

// ─── Bybit P2P API ──────────────────────────────────────────
// Используется ТОЛЬКО публичный эндпоинт фронтенда Bybit (taker feed):
//   POST https://api2.bybit.com/fiat/otc/item/online (без ключа).
// Он совпадает с тем, что видит пользователь в UI Bybit (проверено вживую:
// 478.90 = 478.90). Официальный advertiser-API (/v5/p2p/item/online) возвращает
// более широкую книгу с объявлениями по цене ~403 KZT, которых тейдеры в UI
// не видят, — его данные давали бы ложные алерты, поэтому здесь он НЕ используется.
// Семантика side (публичный API): «1» = buy (мы покупаем USDT → объявления продавцов), «0» = sell.
const BYBIT_PUBLIC_URL = 'https://api2.bybit.com/fiat/otc/item/online';

// Приводим объявление Bybit к общему виду (как у Wallet).
// payments может быть массивом ID методов оплаты (строки) или объектов {paymentName, ...}.
function normalizeBybitAd(item) {
  return {
    id: item.id ?? item.goodsId ?? item.adId ?? null,
    price: String(item.price ?? ''),
    minAmount: item.minAmount,
    maxAmount: item.maxAmount,
    payments: (item.payments || [])
      .map((p) => (typeof p === 'string' ? p : p.paymentName || p.paymentType || p.name || p.method || ''))
      .filter(Boolean),
    nickname: item.nickName || item.nickname || '',
    executeRate: item.recentExecuteRate ?? item.executeRate,
    orderNum: item.recentOrderNum ?? item.orderNum ?? item.completeNum ?? 0,
  };
}

async function fetchBybitPublicAds(sideToFetch, page = 1, pageSize = 20) {
  try {
    const response = await axios.post(BYBIT_PUBLIC_URL, {
      userId: '',
      tokenId: CRYPTO,
      currencyId: FIAT,
      payment: [],
      side: sideToFetch === 'SELL' ? '1' : '0', // публичный API: «1» = buy
      size: String(pageSize),
      page: String(page),
      amount: '',
      authMaker: false,
      canTrade: true,
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (p2p-monitor)',
      },
      timeout: 15000,
    });

    const data = response.data;
    // Принимаем и retCode, и ret_code; свободное == 0 покрывает число/строку
    const ok = data && typeof data === 'object' && (data.retCode == 0 || data.ret_code == 0);
    if (ok) {
      // Пропускаем объявления, где продавец требует наличие своего объявления,
      // и берём ТОЛЬКО онлайн-объявления: isOnline=false (офлайн/скам-приманки
      // типа 402.99 KZT) в тейдерском фиде UI не показываются — не мониторим их.
      const items = (data.result?.items || [])
        .filter((i) => !((i.tradingPreferenceSet || {}).hasUnPostAd))
        .filter((i) => i.isOnline === true || i.isOnline === 1);
      return items.map(normalizeBybitAd);
    }
    // Любая ошибка (битый ответ, retCode != 0 — например 10006 rate limit)
    // возвращается как null → checkPlatformPrice покажет «API error, retrying»,
    // а не ложное «нет объявлений». Пустая страница всегда retCode 0 + пустые items.
    console.warn('⚠️  Bybit public API error:', data?.retCode ?? data?.ret_code ?? 'malformed', data?.retMsg || data?.ret_msg || '');
    return null;
  } catch (error) {
    const msg = error.response
      ? `HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`
      : error.message;
    console.error('❌ Bybit public API Error:', msg);
    return null;
  }
}

// Основной фетчер: публичный эндпоинт — единственный источник (см. комментарий выше).
// Ошибка публичного API (null) → fetchAllAds вернёт null → «API error, retrying»;
// легитимно пустая страница ([]) — как есть. Смешивания с другой книгой нет.
async function fetchBybitAds(sideToFetch, page = 1) {
  return fetchBybitPublicAds(sideToFetch, page, 20);
}

// ─── Generic multi-page fetch + dedupe ──────────────────────
async function fetchAllAds(fetcher, sideToFetch) {
  const pages = [1, 2, 3, 4, 5];
  const results = await Promise.all(pages.map((page) => fetcher(sideToFetch, page)));

  const allAds = [];
  const seenIds = new Set();

  for (const ads of results) {
    if (ads) {
      for (const ad of ads) {
        // Ads without an id must not collapse into a single entry via the Set
        if (ad.id == null || !seenIds.has(ad.id)) {
          seenIds.add(ad.id);
          allAds.push(ad);
        }
      }
    }
  }

  // Page 1 holds the best (lowest for SELL) prices. If it fails, partial pages 2-5
  // would yield a wrong "best price" → false alerts or missed alerts. Later-page
  // failures are tolerated: they only affect totals, not the best price.
  if (results[0] === null) return null;

  // Фильтр по лимитам: убираем объявления вне диапазона сумм пользователя
  // (например «1 000 000–5 000 000 KZT» при лимите 0–500 000). Цены, /top и
  // алерты строятся только по объявлениям, которые реально можно купить.
  if (minLimit != null || maxLimit != null) {
    return allAds.filter(adWithinLimits);
  }
  return allAds;
}

// ─── Price Analysis ─────────────────────────────────────────

// Объявление проходит фильтр лимитов, если его диапазон [minAmount, maxAmount]
// пересекается с пользовательским [minLimit, maxLimit]. Если у объявления лимиты
// не указаны вовсе — не отфильтровываем (данные неполные, а не вне диапазона).
function adWithinLimits(ad) {
  if (minLimit == null && maxLimit == null) return true;
  const lo = parseFloat(ad.minAmount);
  const hi = parseFloat(ad.maxAmount);
  const hasLo = Number.isFinite(lo);
  const hasHi = Number.isFinite(hi);
  if (!hasLo && !hasHi) return true;
  const uMin = minLimit == null ? 0 : minLimit;
  const uMax = maxLimit == null ? Infinity : maxLimit;
  const adMin = hasLo ? lo : 0;
  const adMax = hasHi ? hi : Infinity;
  return adMin <= uMax && adMax >= uMin;
}

function analyzeAds(ads, sideToFetch) {
  if (!ads || ads.length === 0) return null;

  // Drop non-numeric prices; a single NaN would poison Math.min/max below
  const prices = ads
    .map((ad) => parseFloat(ad.price))
    .filter((p) => Number.isFinite(p));
  if (prices.length === 0) return null;

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

// Format price nicely (fall back to '—' for missing/invalid values)
function fmtPrice(price) {
  const n = Number(price);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Escape legacy-Markdown special chars in user-controlled text (nicknames, payments).
// Unescaped '*'/'_'/'['/'`' make Telegram's Markdown parser fail → message (alert) is lost.
function esc(text) {
  return String(text ?? '')
    // Collapse newlines first: an unescaped \n inside a *...* span would leave
    // an unterminated entity and Telegram would reject the whole message (alert lost)
    .replace(/[\r\n]+/g, ' ')
    .replace(/([_*[`\\])/g, '\\$1');
}

// Side label in Russian
function sideLabel(side) {
  return side === 'SELL' ? '🔴 Купить (SELL)' : '🟢 Продать (BUY)';
}

// Текущий диапазон лимитов для отображения
function fmtLimits() {
  if (minLimit == null && maxLimit == null) return 'не задан';
  const lo = minLimit != null ? fmtPrice(minLimit) : '0,00';
  const hi = maxLimit != null ? fmtPrice(maxLimit) : '∞';
  return `${lo}–${hi} KZT`;
}

// ─── Inline Keyboard ───────────────────────────────────────
function mainInlineKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('🛒 Порог КУПИТЬ KZT', 'set_thresh_sell_KZT'),
    ],
  ]);
}

// Reply keyboard — always visible, shown on /start.
// NOTE: options object passed to keyboard() feeds the column builder and silently
// drops is_persistent — must use the .persistent() chain method instead.
const mainKeyboard = Markup.keyboard([
  ['📊 Статус', '🔎 Проверить цену'],
  ['🛒 Порог KZT'],
  ['⏸ Пауза', '▶️ Возобновить']
]).persistent().resize();

// Build a status message (pair + per-platform prices)
function buildStatusMessage() {
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const mins = Math.floor((uptime % 3600) / 60);

  const lines = [
    `📊 *Статус мониторинга*`,
    ``,
    `• Состояние: ${monitoring ? '✅ Активен' : '⏸ Приостановлен'}`,
    `• Интервал: ${Math.round(INTERVAL_MS / 1000)} сек`,
    ``,
    `━━━ *USDT/${FIAT}* (КУПИТЬ) ━━━`,
    `• Порог: ${sellThreshold ? fmtPrice(sellThreshold) : 'не задан'}`,
    `• Лимиты: ${fmtLimits()}`,
  ];

  for (const id of PLATFORM_IDS) {
    const p = platforms[id];
    const price = p.lastBestPrice.SELL;
    lines.push(`• ${p.name}: ${price !== null ? fmtPrice(price) : '—'}`);
  }

  lines.push(
    ``,
    `📈 *Статистика*`,
    `• Проверок: ${totalChecks}`,
    `• Алертов: ${totalAlerts}`,
    `• Последняя проверка: ${lastCheckTime ? lastCheckTime.toLocaleTimeString('ru-RU') : '—'}`,
    `• Аптайм: ${hours}ч ${mins}м`,
  );

  return lines.join('\n');
}

// Build simplified price alert message (per platform)
function buildAlertMessage(analysis, side, fiat, platformName) {
  const { bestPrice, totalAds, bestAd } = analysis;
  const sideTitle = side === 'SELL' ? 'ВЫ МОЖЕТЕ КУПИТЬ' : 'ВЫ МОЖЕТЕ ПРОДАТЬ';

  const lines = [
    `🔔 *${sideTitle}* (${platformName} · ${fiat})`,
    ``,
    `💰 *Цена:* \`${fmtPrice(bestPrice)} ${fiat}\``,
  ];

  if (bestAd) {
    lines.push(
      ``,
      `👤 *Продавец:* ${esc(bestAd.nickname) || '—'}`,
      `💳 *Оплата:* ${esc((bestAd.payments || []).join(', ')) || '—'}`,
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
async function checkPlatformPrice(platformConfig, side) {
  const fiat = FIAT;
  const rawAds = await fetchAllAds(fetcherFor(platformConfig.id), side);

  if (rawAds === null) {
    console.log(`⚠️  [${new Date().toLocaleTimeString()}] API error ${platformConfig.name} ${side} ${fiat}, retrying...`);
    return;
  }

  if (rawAds.length === 0) {
    console.log(`📭 [${new Date().toLocaleTimeString()}] No ads from ${platformConfig.name} (${side} ${fiat})`);
    return;
  }

  const analysis = analyzeAds(rawAds, side);
  if (!analysis) return;

  const { bestPrice } = analysis;
  console.log(`✅ [${lastCheckTime.toLocaleTimeString()}] ${platformConfig.name} ${fiat} ${side} Best: ${fmtPrice(bestPrice)} | Ads: ${analysis.totalAds}`);

  // Determine if we should send an alert (общий порог, дедупликация по цене)
  let shouldAlert = false;
  const prevPrice = platformConfig.lastBestPrice[side];

  if (sellThreshold && bestPrice !== prevPrice) {
    if (bestPrice <= sellThreshold) {
      shouldAlert = true;
    }
  }

  if (shouldAlert) {
    await sendAlert(buildAlertMessage(analysis, side, fiat, platformConfig.name));
  }

  platformConfig.lastBestPrice[side] = bestPrice;
}

async function checkPrices() {
  // Re-entrancy guard: if a check takes longer than CHECK_INTERVAL, the next timer
  // tick must not start a concurrent run (overlapping runs corrupt totalChecks/
  // lastBestPrice and can emit duplicated or missed alerts).
  if (!monitoring || checkInProgress) return;
  checkInProgress = true;
  try {
    totalChecks++;
    lastCheckTime = new Date();

    // Обе площадки опрашиваем параллельно
    const tasks = PLATFORM_IDS.map((id) => checkPlatformPrice(platforms[id], 'SELL'));
    await Promise.all(tasks);
  } finally {
    checkInProgress = false;
  }
}

// ─── Bot Commands ───────────────────────────────────────────

// Security middleware
bot.use((ctx, next) => {
  const userId = String(ctx.from?.id);
  const expectedId = String(CHAT_ID);
  if (userId !== expectedId) {
    console.log(`🔒 Command blocked: user=${userId}, expected=${expectedId}`);
    return ctx.reply('⛔ Доступ запрещён. Ваш Chat ID не совпадает с настроенным.');
  }
  return next();
});

bot.command('start', (ctx) => {
  ctx.reply(
    `👋 *Привет! Я P2P Monitor Bot*\n\n` +
    `Я мониторю покупку USDT/KZT на двух площадках: Wallet и Bybit.\n` +
    `Используйте кнопки для навигации 👇`,
    { parse_mode: 'Markdown', ...mainKeyboard }
  );
});

bot.command('help', (ctx) => {
  ctx.reply(
    `📖 *Справка P2P Monitor*\n\n` +
    `*Команды:*\n` +
    `/status — статус бота и статистика\n` +
    `/price — мгновенная проверка цены (обе площадки)\n` +
    `/top — топ-5 предложений (обе площадки)\n` +
    `/pause — остановить проверки\n` +
    `/resume — запустить проверки\n` +
    `/set\\_threshold <цена> — установить порог покупки\n` +
    `/set\\_min\\_limit <KZT> — мин. сумма объявления\n` +
    `/set\\_max\\_limit <KZT> — макс. сумма объявления\n\n` +
    `*Примеры:*\n` +
    `\`/set_threshold 445\` — алерт, если цена покупки KZT <= 445\n\n` +
    `*Мониторинг:*\n` +
    `• Пара: USDT/KZT (только покупка USDT)\n` +
    `• Площадки: Wallet и Bybit\n` +
    `• Проверка каждые ${CHECK_INTERVAL} сек\n` +
    `• Лимиты: ${fmtLimits()}\n` +
    `• Алерт приходит от площадки, чья цена достигла порога`,
    { parse_mode: 'Markdown', ...mainKeyboard }
  );
});

bot.command('status', (ctx) => {
  waitingForThreshold = null; // user navigated away from any pending threshold prompt
  ctx.reply(buildStatusMessage(), { parse_mode: 'Markdown', ...mainInlineKeyboard() });
});

bot.command('price', async (ctx) => {
  waitingForThreshold = null;
  ctx.reply('🔍 Проверяю...');
  for (const id of PLATFORM_IDS) {
    const platform = platforms[id];
    const rawAds = await fetchAllAds(fetcherFor(id), 'SELL');
    if (rawAds === null) {
      await ctx.reply(`❌ Ошибка API у ${platform.name}. Попробуй позже.`);
      continue;
    }
    if (rawAds.length === 0) {
      await ctx.reply(`📭 Объявлений не найдено у ${platform.name} (КУПИТЬ ${FIAT}).`);
      continue;
    }
    const analysis = analyzeAds(rawAds, 'SELL');
    await ctx.reply(buildAlertMessage(analysis, 'SELL', FIAT, platform.name), { parse_mode: 'Markdown' });
  }
});

const topHandler = async (ctx) => {
  waitingForThreshold = null;
  ctx.reply('🔍 Загружаю топ...');
  for (const id of PLATFORM_IDS) {
    const platform = platforms[id];
    const rawAds = await fetchAllAds(fetcherFor(id), 'SELL');
    if (rawAds === null) {
      await ctx.reply(`❌ Ошибка API у ${platform.name}.`);
      continue;
    }
    if (rawAds.length === 0) {
      await ctx.reply(`📭 Объявлений не найдено у ${platform.name} (КУПИТЬ ${FIAT}).`);
      continue;
    }

    const sorted = [...rawAds].sort((a, b) => {
      const pa = parseFloat(a.price);
      const pb = parseFloat(b.price);
      return pa - pb;
    });
    const top5 = sorted.slice(0, 5);

    const lines = [
      `🏆 *Топ-5 предложений*`,
      `\`USDT/${FIAT}\` | ${platform.name} | ${sideLabel('SELL')}`,
      ``,
    ];

    top5.forEach((ad, i) => {
      const medal = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'][i];
      const rate = ad.executeRate ? (parseFloat(ad.executeRate) * 100).toFixed(1) + '%' : '—';
      lines.push(
        `${medal} *${fmtPrice(ad.price)} ${FIAT}*`,
        `   👤 ${esc(ad.nickname) || '—'} | ⭐ ${rate} | 📦 ${ad.orderNum || 0} сделок`,
        `   💳 ${esc((ad.payments || []).join(', ')) || '—'}`,
        `   📏 ${fmtPrice(ad.minAmount)}–${fmtPrice(ad.maxAmount)} ${FIAT}`,
        ``,
      );
    });

    lines.push(`📊 Всего объявлений: ${rawAds.length}`);
    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
  }
};

bot.command('top', topHandler);

bot.command('pause', (ctx) => {
  waitingForThreshold = null;
  if (!monitoring) return ctx.reply('⏸ Мониторинг уже приостановлен.');
  monitoring = false;
  ctx.reply('⏸ Мониторинг приостановлен. Нажмите «Возобновить» чтобы продолжить.', mainInlineKeyboard());
});

bot.command('resume', (ctx) => {
  waitingForThreshold = null;
  if (monitoring) return ctx.reply('✅ Мониторинг уже работает.');
  monitoring = true;
  // Reset prices — чтобы сразу переоценить после паузы
  for (const id of PLATFORM_IDS) {
    platforms[id].lastBestPrice = { SELL: null };
  }
  ctx.reply('▶️ Мониторинг возобновлён!', mainInlineKeyboard());
  checkPrices();
});

// ─── Inline Button Handlers ─────────────────────────────────

bot.action('action_status', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(buildStatusMessage(), { parse_mode: 'Markdown', ...mainInlineKeyboard() });
});

// Threshold inline button — ask user to type the value
bot.action('set_thresh_sell_KZT', async (ctx) => {
  await ctx.answerCbQuery();
  waitingForThreshold = { side: 'SELL', fiat: 'KZT' };
  await ctx.reply(
    `Введите новую цену для порога КУПИТЬ (KZT).\n` +
    `Текущий порог: ${sellThreshold ? fmtPrice(sellThreshold) : 'не задан'}`,
    Markup.forceReply()
  );
});

// ─── Reply Keyboard Handlers ────────────────────────────────

bot.hears('📊 Статус', (ctx) => {
  waitingForThreshold = null;
  ctx.reply(buildStatusMessage(), { parse_mode: 'Markdown', ...mainInlineKeyboard() });
});

bot.hears('🔎 Проверить цену', async (ctx) => {
  waitingForThreshold = null;
  ctx.reply('🔍 Проверяю...');
  for (const id of PLATFORM_IDS) {
    const platform = platforms[id];
    const rawAds = await fetchAllAds(fetcherFor(id), 'SELL');
    if (rawAds === null) {
      await ctx.reply(`❌ Ошибка API у ${platform.name}. Попробуй позже.`);
      continue;
    }
    if (rawAds.length === 0) {
      await ctx.reply(`📭 Объявлений не найдено у ${platform.name} (КУПИТЬ ${FIAT}).`);
      continue;
    }
    const analysis = analyzeAds(rawAds, 'SELL');
    await ctx.reply(buildAlertMessage(analysis, 'SELL', FIAT, platform.name), { parse_mode: 'Markdown' });
  }
});

bot.hears('🛒 Порог KZT', (ctx) => {
  waitingForThreshold = { side: 'SELL', fiat: 'KZT' };
  ctx.reply(
    `Введите новую цену для порога КУПИТЬ (KZT).\nТекущий: ${sellThreshold ? fmtPrice(sellThreshold) : 'не задан'}`,
    Markup.forceReply()
  );
});

bot.hears('⏸ Пауза', (ctx) => {
  waitingForThreshold = null;
  if (!monitoring) return ctx.reply('⏸ Мониторинг уже приостановлен.');
  monitoring = false;
  ctx.reply('⏸ Мониторинг приостановлен. Нажмите «Возобновить» чтобы продолжить.', mainInlineKeyboard());
});

bot.hears('▶️ Возобновить', (ctx) => {
  waitingForThreshold = null;
  if (monitoring) return ctx.reply('✅ Мониторинг уже работает.');
  monitoring = true;
  // Reset prices
  for (const id of PLATFORM_IDS) {
    platforms[id].lastBestPrice = { SELL: null };
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
    '🛒 Порог KZT',
    '⏸ Пауза', '▶️ Возобновить'
  ].includes(text)) {
    return next();
  }

  const isReply = ctx.message.reply_to_message?.text?.includes('Введите новую цену для порога');

  if (isReply || waitingForThreshold) {
    const val = parseFloat(text.replace(',', '.'));

    if (!Number.isFinite(val) || val <= 0) {
      // Keep waiting and tell the user instead of silently swallowing the message
      return ctx.reply('⚠️ Введите корректное положительное число (например: 449.50)');
    }

    sellThreshold = val;
    // Force an immediate re-evaluation on both platforms: if the current price is
    // already at/below the new threshold, the next check must alert.
    for (const id of PLATFORM_IDS) {
      platforms[id].lastBestPrice = { SELL: null };
    }

    waitingForThreshold = null;
    return ctx.reply(
      `✅ Порог КУПИТЬ (KZT) установлен: *${fmtPrice(val)} KZT*`,
      { parse_mode: 'Markdown', ...mainInlineKeyboard() }
    );
  }

  return next();
});

// /set_threshold <цена>  (совместим и с /set_threshold kzt <цена>)
bot.command('set_threshold', (ctx) => {
  const args = ctx.message.text.split(' ').slice(1).filter(Boolean);

  let priceArg;
  if (args.length === 2) {
    if (args[0].toUpperCase() !== 'KZT') {
      return ctx.reply('❌ RUB больше не поддерживается. Укажите `kzt` или просто цену.', { parse_mode: 'Markdown' });
    }
    priceArg = args[1];
  } else if (args.length === 1) {
    priceArg = args[0];
  } else {
    return ctx.reply(
      '⚠️ Использование: `/set_threshold <цена>`\n' +
      'Например: `/set_threshold 445`',
      { parse_mode: 'Markdown' }
    );
  }

  const val = parseFloat(priceArg.replace(',', '.'));

  if (!Number.isFinite(val) || val <= 0) {
    return ctx.reply('❌ Введите корректное положительное число (например: 445)');
  }

  sellThreshold = val;
  // Force immediate re-evaluation (see text-handler note above)
  for (const id of PLATFORM_IDS) {
    platforms[id].lastBestPrice = { SELL: null };
  }

  waitingForThreshold = null;
  ctx.reply(
    `🎯 Порог КУПИТЬ (KZT) установлен: *${fmtPrice(val)} KZT*`,
    { parse_mode: 'Markdown', ...mainInlineKeyboard() }
  );
});

// /set_min_limit <KZT|off> — минимальная сумма объявления (off/0 — сброс)
bot.command('set_min_limit', (ctx) => {
  const arg = (ctx.message.text.split(' ').slice(1).filter(Boolean)[0] || '').toLowerCase();
  if (!arg) {
    return ctx.reply(
      '⚠️ Использование: `/set_min_limit <KZT>`\n' +
      'Например: `/set_min_limit 10000`\n' +
      '`/set_min_limit off` — отключить фильтр',
      { parse_mode: 'Markdown' }
    );
  }

  if (arg === 'off' || arg === '0') {
    minLimit = null;
  } else {
    const val = parseFloat(arg.replace(',', '.'));
    if (!Number.isFinite(val) || val < 0) {
      return ctx.reply('❌ Введите корректное неотрицательное число (например: 10000)');
    }
    if (maxLimit != null && val > maxLimit) {
      return ctx.reply(`❌ Минимум (${fmtPrice(val)} KZT) не может быть больше максимума (${fmtPrice(maxLimit)} KZT).`);
    }
    minLimit = val;
  }

  // Force immediate re-evaluation (see set_threshold note)
  for (const id of PLATFORM_IDS) {
    platforms[id].lastBestPrice = { SELL: null };
  }
  waitingForThreshold = null;
  ctx.reply(
    `📏 Мин. лимит объявления: *${fmtLimits()}*`,
    { parse_mode: 'Markdown', ...mainInlineKeyboard() }
  );
});

// /set_max_limit <KZT|off> — максимальная сумма объявления (off/0 — сброс)
bot.command('set_max_limit', (ctx) => {
  const arg = (ctx.message.text.split(' ').slice(1).filter(Boolean)[0] || '').toLowerCase();
  if (!arg) {
    return ctx.reply(
      '⚠️ Использование: `/set_max_limit <KZT>`\n' +
      'Например: `/set_max_limit 500000`\n' +
      '`/set_max_limit off` — отключить фильтр',
      { parse_mode: 'Markdown' }
    );
  }

  if (arg === 'off' || arg === '0') {
    maxLimit = null;
  } else {
    const val = parseFloat(arg.replace(',', '.'));
    if (!Number.isFinite(val) || val < 0) {
      return ctx.reply('❌ Введите корректное неотрицательное число (например: 500000)');
    }
    if (minLimit != null && val < minLimit) {
      return ctx.reply(`❌ Максимум (${fmtPrice(val)} KZT) не может быть меньше минимума (${fmtPrice(minLimit)} KZT).`);
    }
    maxLimit = val;
  }

  // Force immediate re-evaluation (see set_threshold note)
  for (const id of PLATFORM_IDS) {
    platforms[id].lastBestPrice = { SELL: null };
  }
  waitingForThreshold = null;
  ctx.reply(
    `📏 Макс. лимит объявления: *${fmtLimits()}*`,
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
    pair: `USDT/${FIAT}`,
    platforms: PLATFORM_IDS,
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
  console.log('  🚀 P2P Monitor Bot (Wallet + Bybit)');
  console.log('═══════════════════════════════════════════');
  console.log(`  Pair:     USDT/${FIAT} (КУПИТЬ)`);
  console.log(`  Platforms: ${PLATFORM_IDS.join(', ')}`);
  console.log(`  Interval: ${CHECK_INTERVAL}s`);
  console.log(`  Sell Thr: ${sellThreshold || 'disabled'}`);
  console.log(`  Limits:   ${fmtLimits()}`);
  console.log('═══════════════════════════════════════════');

  // Start Express server
  app.listen(parseInt(PORT, 10), () => {
    console.log(`🌐 Keep-alive server on port ${PORT}`);
  });

  // Clear any stale webhook left from a previous deployment (Render / webhook mode).
  // If a webhook is set, Telegram rejects getUpdates with 409 → polling never
  // receives updates, while alerts still work (sendMessage is a plain API call).
  // drop_pending_updates: stale commands queued during the outage would otherwise
  // execute all at once (e.g. old threshold changes) — discard them.
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    console.log('✅ Stale webhook cleared (polling mode)');
  } catch (err) {
    console.warn('⚠️ deleteWebhook failed:', err.message);
  }

  // Launch Telegram bot (attach .catch so an invalid token rejects the returned
  // promise instead of crashing the process via an unhandled rejection)
  bot.launch().catch((err) => {
    if (/409|Conflict|terminated by other getUpdates/i.test(err.message)) {
      console.error('❌ 409 Conflict: бот запущен В ДВУХ МЕСТАХ! Останови второй инстанс (Render?) и перезапусти контейнер: docker compose restart');
    }
    console.error('❌ Telegram bot launch failed:', err.message);
  });
  console.log('🤖 Telegram bot started');

  // Register commands menu
  try {
    await bot.telegram.setMyCommands([
      { command: 'status', description: '📊 Статус мониторинга' },
      { command: 'price', description: '🔎 Проверить цены сейчас' },
      { command: 'top', description: '🏆 Топ-5 предложений' },
      { command: 'pause', description: '⏸ Приостановить мониторинг' },
      { command: 'resume', description: '▶️ Возобновить мониторинг' },
      { command: 'set_min_limit', description: '📏 Мин. лимит суммы объявления' },
      { command: 'set_max_limit', description: '📏 Макс. лимит суммы объявления' },
      { command: 'help', description: '📖 Справка' }
    ]);
    console.log('✅ Telegram bot commands menu registered');
  } catch (err) {
    console.error('⚠️ Failed to set commands:', err.message);
  }

  // Send startup notification
  await sendAlert(
    `🚀 *P2P Monitor запущен!*\n\n` +
    `• Пара: USDT/${FIAT} (КУПИТЬ)\n` +
    `• Площадки: ${PLATFORM_IDS.join(', ')}\n` +
    `• Интервал: ${CHECK_INTERVAL} сек\n` +
    `• Порог: ${sellThreshold ? fmtPrice(sellThreshold) : 'не задан'}\n` +
    `• Лимиты: ${fmtLimits()}\n\n` +
    `Отправь /help для списка команд.`
  );

  // Start monitoring loop
  await checkPrices();
  checkTimer = setInterval(checkPrices, INTERVAL_MS);
}

// Catch unhandled errors inside bot handlers (network blips, parse errors, …)
bot.catch((err) => {
  console.error('❌ Bot handler error:', err.message);
});

// Graceful shutdown. bot.stop() throws 'Bot is not running!' if launch() failed
// (invalid/revoked token, Telegram unreachable) — guard so the process still
// exits cleanly instead of crashing inside the signal handler.
function shutdown(signal) {
  console.log('\n🛑 Shutting down...');
  clearInterval(checkTimer);
  try {
    bot.stop(signal);
  } catch (err) {
    console.error('⚠️ Bot stop error (bot may not have launched):', err.message);
  }
  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});

# 🤖 Wallet P2P Monitor Bot

Telegram-бот для мониторинга цен на P2P маркете [Wallet](https://wallet.tg).

## Что умеет

- 📊 **Мониторинг в реальном времени** — проверяет цены каждые N секунд
- 🔔 **Умные алерты** — уведомляет только при значимых изменениях (≥ 0.5%)
- 🎯 **Порог цены** — алерт при падении цены ниже заданного значения
- 🏆 **Топ объявлений** — лучшие 5 предложений по команде
- ⏸ **Пауза/Резюме** — контроль через Telegram
- 🔄 **Смена пары** — переключай крипту/фиат/направление на лету

## Быстрый старт

### 1. Получи ключи

| Ключ | Где взять |
|------|-----------|
| `BOT_TOKEN` | [@BotFather](https://t.me/BotFather) — создай нового бота |
| `CHAT_ID` | [@userinfobot](https://t.me/userinfobot) — узнай свой ID |
| `WALLET_API_KEY` | Wallet → P2P Маркет → Профиль → API Keys |

### 2. Настрой окружение

```bash
cp .env.example .env
```

Заполни `.env` своими ключами.

### 3. Установи и запусти

```bash
npm install
npm start
```

## Команды бота

| Команда | Описание |
|---------|----------|
| `/start` | Приветствие и список команд |
| `/status` | Текущий статус и статистика |
| `/price` | Мгновенная проверка цены |
| `/top` | Топ-5 лучших объявлений |
| `/pause` | Приостановить мониторинг |
| `/resume` | Возобновить мониторинг |
| `/set_pair USDT KZT SELL` | Сменить торговую пару |
| `/help` | Справка |

## Переменные окружения

| Переменная | Обязательно | По умолчанию | Описание |
|-----------|:-----------:|:------------:|----------|
| `BOT_TOKEN` | ✅ | — | Токен Telegram бота |
| `CHAT_ID` | ✅ | — | Твой Telegram ID |
| `WALLET_API_KEY` | ✅ | — | API ключ Wallet P2P |
| `CHECK_INTERVAL` | ❌ | `30` | Интервал проверки (сек) |
| `CRYPTO_CURRENCY` | ❌ | `USDT` | Криптовалюта |
| `FIAT_CURRENCY` | ❌ | `KZT` | Фиатная валюта |
| `SIDE` | ❌ | `SELL` | Направление (BUY/SELL) |
| `PRICE_THRESHOLD` | ❌ | — | Порог алерта цены |
| `PORT` | ❌ | `3000` | Порт для Express |

## Деплой на Render

### 1. GitHub
```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/wallet-p2p-monitor.git
git push -u origin main
```

### 2. Render.com
1. Создай **Web Service** 
2. Build Command: `npm install`
3. Start Command: `npm start`
4. Добавь env переменные в **Environment**

### 3. Обход сна (Cron-job.org)
1. Зарегистрируйся на [cron-job.org](https://cron-job.org)
2. Создай задачу: `GET https://твой-проект.onrender.com/health`
3. Интервал: каждые **10 минут**

## Архитектура

```
index.js
├── Express Server (/health, /) — keep-alive для Render
├── Telegraf Bot — обработка команд
├── checkPrices() — основной цикл
│   ├── fetchAds() — POST к Wallet P2P API
│   ├── analyzeAds() — мин/макс/средняя/спред
│   └── sendAlert() — уведомление в Telegram
└── setInterval — запуск checkPrices каждые N сек
```

## Лицензия

MIT

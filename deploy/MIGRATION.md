# 📋 Чеклист переезда: Render → VPS (день X)

Цель: бот работает 24/7 на VPS, команды и алерты отвечают, Render выключен.
Время: ~15–20 минут. Всё обратимо — схема отката в конце.

---

## 0. Подготовка (заранее, до дня X)

- [ ] Последние коммиты запушены: `git log origin/main --oneline -3` → должен быть `b9940e7` (deploy script) и свежее
- [ ] SSH на VPS работает: `ssh root@VPS`
- [ ] На VPS установлены Docker и compose: `docker --version && docker compose version`
- [ ] Под рукой ключи из Render (Web Service → Environment): `BOT_TOKEN`, `CHAT_ID`, `WALLET_API_KEY`
- [ ] Порты не конфликтуют: `ssh root@VPS "ss -tlnp | grep -E ':(3000|5433)'"` → 3000 свободен для p2p-monitor (starswap-v2 хост-порты не слушает)

## 1. Остановить Render — СНАЧАЛА

> Пока Render крутится, бот на VPS получит конфликт 409 и команды не будут обрабатываться.

- [ ] Render Dashboard → Web Service → **Pause** (не Delete — на случай отката)
- [ ] cron-job.org → поставить задачу `/health` на паузу или удалить
- [ ] Подождать минуту и убедиться, что сервис остановлен

## 2. Запуск на VPS

```bash
git clone https://github.com/ayan577/p2pmonitoring.git && cd p2pmonitoring
bash deploy/deploy-vps.sh    # 1-й запуск: клонирует, проверит Docker, создаст .env и остановится
nano .env                    # вставь реальные BOT_TOKEN / CHAT_ID / WALLET_API_KEY (+ при желании CHECK_INTERVAL, SELL_THRESHOLD_KZT, лимиты)
bash deploy/deploy-vps.sh    # 2-й запуск: соберёт и поднимет контейнер
```

## 3. Проверка на сервере

- [ ] `docker compose ps` → контейнер `p2p-monitor` в статусе `Up`
- [ ] `docker compose logs -f` → в логах **нет** `❌ Telegram bot launch failed`, `409`, `rate limit`
- [ ] `curl -fsS http://127.0.0.1:3000/health` → `OK` (порт — какой выбрал скрипт, если 3000 был занят)

## 4. Проверка в Telegram

- [ ] В чат пришло стартовое «🚀 P2P Monitor запущен!»
- [ ] `/status` отвечает. Накопившиеся старые команды придут **разом** — это нормально, они лежали с прошлых дней
- [ ] `/price` — отвечают **обе площадки** (Wallet и Bybit) с ценами
- [ ] Кнопка «🛒 Порог KZT» → ввод числа → «✅ Порог установлен»
- [ ] Кнопка «📊 Статус» работает
- [ ] **Алерт:** `/set_threshold <цена выше текущей>` → в течение `CHECK_INTERVAL` (30 сек) приходит 🔔
- [ ] `⏸ Пауза` / `▶️ Возобновить` работают

## 5. Финализация

- [ ] Всё работает → Render Web Service **Delete** (или оставить Pause, если хочется подстраховаться)
- [ ] Удалить задачу на cron-job.org (больше не нужна)
- [ ] Вернуть боевые значения через Telegram (порог/лимиты)
- [ ] Напоминание: **порог и лимиты, заданные через Telegram, живут в памяти** — при пересборке контейнера (git pull + deploy) они сбросятся к значениям из `.env`. Пропиши боевые значения в `.env` (`SELL_THRESHOLD_KZT`, `MIN_LIMIT_KZT`, `MAX_LIMIT_KZT`), чтобы они переживали рестарты

## 6. Откат (если что-то пошло не так)

```bash
# на VPS — остановить бота
docker compose down
```

- [ ] Render Dashboard → **Resume** → бот снова поднимется на Render (конфликта 409 не будет: на VPS он остановлен)
- [ ] Вернуть задачу cron-job.org (если удалял)

---

## Диагностика типовых проблем

| Симптом | Причина | Решение |
|---|---|---|
| Алерты приходят, команды молчат | 409: бот запущен в двух местах / Render не остановлен | `docker compose logs` → ищи «launch failed»; останови Render; `docker compose restart` |
| Сразу пришли старые команды | Накопленные апдейты Telegram | Норма. Ничего не делать |
| `429`/`403` от Bybit | Слишком частый опрос | `CHECK_INTERVAL` ≥ 30 сек в `.env` |
| Порт 3000 занят | Второй проект | Скрипт сам возьмёт свободный (3100+); явно: `P2P_PORT=4100 bash deploy/deploy-vps.sh` |

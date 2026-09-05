#!/usr/bin/env bash
#
# deploy-vps.sh — развёртывание P2P Monitor бота на VPS одной командой.
#
# Что делает:
#   1. Клонирует (или обновляет) репозиторий
#   2. Проверяет Docker и docker compose
#   3. Создаёт .env из .env.example, если его нет (и останавливается — заполни ключи)
#   4. Проверяет, что хост-порт свободен (чтобы не конфликтовать со вторым проектом
#      на VPS) и при необходимости автоматически берёт свободный (3000 → 3100 → …)
#   5. Собирает и запускает контейнер: docker compose up -d --build
#   6. Ждёт ответа /health и печатает итог
#
# Запуск (изнутри клонированного репо):
#   bash deploy/deploy-vps.sh
#   # или с явным портом:
#   P2P_PORT=4100 bash deploy/deploy-vps.sh
#
# Повторный запуск = обновление: подтянет новые коммиты и пересоберёт контейнер.

set -euo pipefail

REPO_URL="https://github.com/ayan577/p2pmonitoring.git"
CONTAINER_NAME="p2p-monitor"

info() { printf 'ℹ️  %s\n' "$*"; }
ok()   { printf '✅ %s\n' "$*"; }
warn() { printf '⚠️  %s\n' "$*"; }
fail() { printf '❌ %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || fail "git не найден. Установи: apt install git (или аналог для твоего дистрибутива)"

# ─── 1. Определяем/клонируем репозиторий ─────────────────────
if [ -f index.js ] && [ -d .git ]; then
  REPO_DIR="$(pwd)"
  ok "Использую текущую папку как репозиторий: $REPO_DIR"
elif [ "$(id -u)" = "0" ]; then
  REPO_DIR="/opt/p2p-monitor"
else
  REPO_DIR="$HOME/p2p-monitor"
fi

if [ ! -d "$REPO_DIR/.git" ]; then
  info "Клонирую репозиторий в $REPO_DIR ..."
  mkdir -p "$REPO_DIR"
  git clone "$REPO_URL" "$REPO_DIR"
  ok "Репозиторий склонирован"
else
  # ВАЖНО: bash читает выполняемый скрипт с диска по ходу дела. Если git pull
  # заменит этот файл прямо во время выполнения, дальше исполнится каша из
  # старой и новой версий (уже ловили: пропускалась секция settings.json).
  # Поэтому при обновлении — перезапускаем уже новую версию скрипта.
  info "Репозиторий уже есть, обновляю (git pull --ff-only) ..."
  before_rev="$(git -C "$REPO_DIR" rev-parse HEAD)"
  ( cd "$REPO_DIR" && git pull --ff-only ) || warn "Не удалось подтянуть обновления — продолжаю с текущей версией"
  after_rev="$(git -C "$REPO_DIR" rev-parse HEAD)"
  if [ "$before_rev" != "$after_rev" ]; then
    info "Скрипт обновлён из git — перезапускаю новую версию ..."
    exec bash "$REPO_DIR/deploy/deploy-vps.sh" "$@"
  fi
fi

cd "$REPO_DIR"

# ─── 2. Проверка Docker ──────────────────────────────────────
command -v docker >/dev/null 2>&1 || fail "docker не найден. Установи: https://docs.docker.com/engine/install/"
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  fail "docker compose (v2) не найден. Установи: https://docs.docker.com/compose/install/"
fi
ok "Docker: $(docker --version | sed 's/Docker version //; s/,.*//')"

# ─── 3. .env ─────────────────────────────────────────────────
if [ ! -f .env ]; then
  cp .env.example .env
  printf '❌ .env создан из шаблона — заполни его ключами и запусти скрипт ещё раз:\n'
  printf '      nano %s/.env\n' "$REPO_DIR"
  exit 1
fi

check_key() {
  local key="$1"
  local val
  val="$(grep -E "^${key}=" .env 2>/dev/null | head -n1 | cut -d'=' -f2- | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  if [ -z "$val" ] || printf '%s' "$val" | grep -qi 'your_\|placeholder'; then
    fail "$key не заполнен в $REPO_DIR/.env (остался шаблон). Заполни и запусти снова."
  fi
}
check_key BOT_TOKEN
check_key CHAT_ID
check_key WALLET_API_KEY
ok "Ключи в .env на месте"

# ─── 4. Порт ─────────────────────────────────────────────────
port_in_use() {
  local p="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -tln 2>/dev/null | awk 'NR>1 { n=split($4, a, ":"); print a[n] }' | grep -qx "$p"
  elif command -v netstat >/dev/null 2>&1; then
    netstat -tln 2>/dev/null | awk '{ n=split($4, a, ":"); print a[n] }' | grep -qx "$p"
  else
    return 1 # ни ss, ни netstat нет — считаем порт свободным
  fi
}

# Если контейнер уже запущен — сохраняем его текущий порт, чтобы не пересоздавать без нужды
running_port="$(docker ps --filter "name=^/${CONTAINER_NAME}$" --format '{{.Ports}}' 2>/dev/null | grep -o ':[0-9]\+->' | head -n1 | sed 's/[^0-9]//g' || true)"

if [ -n "$running_port" ]; then
  HOST_PORT="$running_port"
  info "Контейнер уже запущен на порту $HOST_PORT — сохраняю его"
elif [ -n "${P2P_PORT:-}" ]; then
  HOST_PORT="$P2P_PORT"
  if port_in_use "$HOST_PORT"; then
    fail "Порт $HOST_PORT занят другим процессом. Укажи свободный, например: P2P_PORT=4100 bash deploy/deploy-vps.sh"
  fi
else
  HOST_PORT="3000"
  if port_in_use "$HOST_PORT"; then
    for p in $(seq 3100 3200); do
      if ! port_in_use "$p"; then HOST_PORT="$p"; break; fi
    done
    warn "Порт 3000 занят (возможно, вторым проектом). Автоматически беру свободный порт: $HOST_PORT"
  fi
  export P2P_PORT="$HOST_PORT"
fi
ok "Хост-порт: $HOST_PORT"

# ─── 4b. settings.json (persistent-настройки) ──────────────
# Порог и лимиты, заданные через Telegram, живут в settings.json (volume в
# docker-compose.yml). Если на хосте файла нет, Docker создал бы ДИРЕКТОРИЮ с
# таким именем и настройки не сохранялись бы — поэтому создаём обычный файл.
# Значения берём из .env (пустые → null = без порога/фильтра).
if [ ! -e settings.json ]; then
  info "Создаю settings.json из значений .env ..."
  thr="$(grep -E '^SELL_THRESHOLD_KZT=' .env 2>/dev/null | head -n1 | cut -d'=' -f2- | tr -d '[:space:]')"
  mn="$(grep -E '^MIN_LIMIT_KZT=' .env 2>/dev/null | head -n1 | cut -d'=' -f2- | tr -d '[:space:]')"
  mx="$(grep -E '^MAX_LIMIT_KZT=' .env 2>/dev/null | head -n1 | cut -d'=' -f2- | tr -d '[:space:]')"
  [ -z "$thr" ] && thr="null" && info "SELL_THRESHOLD_KZT пуст — порог: null (алерты выключены до установки через Telegram)"
  [ -z "$mn" ] && mn="null"
  [ -z "$mx" ] && mx="null"
  printf '{\n  "sellThreshold": %s,\n  "minLimit": %s,\n  "maxLimit": %s\n}\n' "$thr" "$mn" "$mx" > settings.json
  ok "settings.json создан (порог=$thr, мин=$mn, макс=$mx)"
elif [ ! -f settings.json ]; then
  fail "settings.json существует, но это не обычный файл (вероятно, директория, созданная Docker). Удали: rm -rf settings.json — и запусти скрипт снова."
else
  ok "settings.json на месте — настройки из Telegram сохранятся"
fi

# ─── 5. Запуск ───────────────────────────────────────────────
info "Собираю и запускаю контейнер ($COMPOSE up -d --build) ..."
$COMPOSE up -d --build
ok "Контейнер запущен: $CONTAINER_NAME"

# ─── 6. Health-check ─────────────────────────────────────────
wait_health() {
  local port="$1" i
  for i in $(seq 1 15); do
    if { command -v curl >/dev/null 2>&1 && curl -fsS "http://127.0.0.1:${port}/health" >/dev/null 2>&1; } || \
       { command -v wget >/dev/null 2>&1 && wget -qO- "http://127.0.0.1:${port}/health" >/dev/null 2>&1; }; then
      ok "Бот отвечает: http://127.0.0.1:${port}/health"
      return 0
    fi
    sleep 2
  done
  warn "Не дождался ответа /health за 30 сек — смотри логи: $COMPOSE logs -f"
}
wait_health "$HOST_PORT"

cat <<EOF

────────────────────────────────────────────────────────
🚀 Бот развёрнут!

  • Папка:         $REPO_DIR
  • Контейнер:     p2p-monitor
  • HTTP (health): http://127.0.0.1:$HOST_PORT
  • Логи:          docker compose logs -f
  • Обновление:    перезапусти этот скрипт (он сам сделает git pull + rebuild)

⚠️  НЕ ЗАБУДЬ ОСТАНОВИТЬ СЕРВИС НА RENDER!
    Пока он крутится, два процесса с одним токеном конфликтуют
    (Telegram отвечает 409) — команды бота не будут обрабатываться.
    Накопившиеся старые команды придут после первого запуска.
────────────────────────────────────────────────────────
EOF

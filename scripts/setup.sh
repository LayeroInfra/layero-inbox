#!/usr/bin/env bash
# Layero Inbox: вся инфраструктура одной командой — база, Data API, вход,
# файлы, схема, уведомления и два проекта на Layero.
#
#   LAYERO_ORG=my-team APP_ADDRESS=my-inbox ./scripts/setup.sh
#
# Переменные:
#   LAYERO_ORG          организация Layero (обязательно)
#   DB_NAME             имя базы, по умолчанию inbox
#   APP_ADDRESS         адрес лендинга и кабинета: <APP_ADDRESS>.layero.app (обязательно)
#   WIDGET_ADDRESS      адрес виджета, по умолчанию <APP_ADDRESS>-widget
#   TELEGRAM_BOT        имя бота без @ — для кнопки «Подключить Telegram» (необязательно)
#   TELEGRAM_BOT_TOKEN  токен бота от @BotFather (необязательно; в аргументы команд не попадает)
#
# Нужны: Node 20+, вход в CLI (`npx layero@latest login`), тариф с общей базой
# или выделенная база.
set -euo pipefail

: "${LAYERO_ORG:?задайте LAYERO_ORG — slug организации Layero}"
: "${APP_ADDRESS:?задайте APP_ADDRESS — адрес будет <APP_ADDRESS>.layero.app}"
DB_NAME="${DB_NAME:-inbox}"
WIDGET_ADDRESS="${WIDGET_ADDRESS:-${APP_ADDRESS}-widget}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
L() { npx -y layero@latest "$@"; }
step() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
# Последнее событие CLI в режиме --json; при событии error — печатаем и выходим.
run() {
  local out
  out="$(L "$@" --json 2>&1 | tail -1)"
  if [ "$(jq -r '.event' <<<"$out" 2>/dev/null)" = "error" ]; then
    echo "$out" | jq -r '"✗ \(.message)\n  → \(.next_action // "")"' >&2
    return 1
  fi
  printf '%s\n' "$out"
}

step "База $DB_NAME"
if L db list --org "$LAYERO_ORG" --json | tail -1 | jq -e --arg n "$DB_NAME" '.databases[] | select(.name == $n)' >/dev/null; then
  echo "уже есть"
else
  run db create "$DB_NAME" --org "$LAYERO_ORG" | jq -r '"создана: \(.name)"'   # строку подключения не печатаем
fi

step "Data API, вход и файлы"
DATA_URL="$(run data enable --db "$DB_NAME" --org "$LAYERO_ORG" --auth --storage | jq -r '.url // empty')"
DATA_URL="${DATA_URL:-$(L data env --json 2>/dev/null | tail -1 | jq -r '.vars.VITE_LAYERO_DATA_URL // empty' || true)}"
echo "${DATA_URL:-Data API включён}"

step "Бакет screenshots (приватный, до 5 МБ, JPEG/PNG)"
run data buckets create screenshots --private --max 5MB --types image/jpeg,image/png \
    --db "$DB_NAME" --org "$LAYERO_ORG" >/dev/null || echo "(бакет уже есть — пропускаем)"

step "Схема: таблицы, RLS, функции"
for f in "$ROOT"/db/migrations/*.sql; do
  run db sql "$DB_NAME" --org "$LAYERO_ORG" --file "$f" | jq -r --arg f "$(basename "$f")" '"\($f): \(.statements | length) операторов"'
done
run db sql "$DB_NAME" --org "$LAYERO_ORG" -c \
  "insert into inbox_private.config (key, value) values ('app_url', 'https://${APP_ADDRESS}.layero.app/dashboard/')
   on conflict (key) do update set value = excluded.value" >/dev/null
echo "app_url = https://${APP_ADDRESS}.layero.app/dashboard/"

step "Письма входа и Telegram"
run data auth sender "Layero Inbox" --db "$DB_NAME" --org "$LAYERO_ORG" >/dev/null && echo "имя отправителя: Layero Inbox"
if [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
  run data secrets set TELEGRAM_BOT_TOKEN --from-env TELEGRAM_BOT_TOKEN --db "$DB_NAME" --org "$LAYERO_ORG" >/dev/null
  echo "секрет TELEGRAM_BOT_TOKEN задан"
else
  echo "TELEGRAM_BOT_TOKEN не задан — уведомления можно включить позже"
fi

step "Виджет: https://${WIDGET_ADDRESS}.layero.app"
(cd "$ROOT/apps/widget" && npm ci --silent && \
  run deploy --org "$LAYERO_ORG" --name "${WIDGET_ADDRESS}" --address "${WIDGET_ADDRESS}" --db "$DB_NAME" --yes | jq -r '.url')

step "Лендинг и кабинет: https://${APP_ADDRESS}.layero.app"
cd "$ROOT/apps/web"
npm ci --silent
run deploy --org "$LAYERO_ORG" --name "${APP_ADDRESS}" --address "${APP_ADDRESS}" --db "$DB_NAME" --yes >/dev/null
run env set "VITE_INBOX_WIDGET_URL=https://${WIDGET_ADDRESS}.layero.app" \
            "VITE_INBOX_TELEGRAM_BOT=${TELEGRAM_BOT:-}" "VITE_INBOX_SITE_KEY=${SITE_KEY:-}" >/dev/null
run deploy --yes | jq -r '.url'

cat <<EOF

Готово.
  Лендинг   https://${APP_ADDRESS}.layero.app
  Кабинет   https://${APP_ADDRESS}.layero.app/dashboard/
  Виджет    https://${WIDGET_ADDRESS}.layero.app/embed.js

Дальше:
  1. Зарегистрируйтесь в кабинете и добавьте сайт — кабинет покажет строку для вставки.
  2. Чтобы виджет работал на самом лендинге, задайте ключ сайта и пересоберите:
       cd apps/web && npx layero@latest env set VITE_INBOX_SITE_KEY=st_… && npx layero@latest deploy --yes
  3. Проверьте права: ./scripts/check-access.sh (см. docs).
EOF

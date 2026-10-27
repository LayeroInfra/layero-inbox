#!/usr/bin/env bash
# Проверка прав Layero Inbox через настоящий шлюз Data API.
# `layero data probe` выполняет запрос от имени посетителя сайта или пользователя;
# записи откатываются, данные не меняются.
#
#   LAYERO_ORG=my-team OWNER_EMAIL=me@mail.ru OTHER_EMAIL=stranger@mail.ru \
#   MEMBER_EMAIL=colleague@mail.ru ./scripts/check-access.sh
#
#   OWNER_EMAIL   владелец сайта (у него должен быть хотя бы один сайт и одно сообщение)
#   OTHER_EMAIL   пользователь не из команды этого сайта, со своим сайтом или без
#   MEMBER_EMAIL  пользователь из команды сайта — принял приглашение (необязательно)
set -euo pipefail
export LC_ALL="${LC_ALL:-en_US.UTF-8}"   # чтобы ${#строка} считал буквы, а не байты
: "${LAYERO_ORG:?задайте LAYERO_ORG}"
: "${OWNER_EMAIL:?задайте OWNER_EMAIL}"
: "${OTHER_EMAIL:?задайте OTHER_EMAIL}"
DB_NAME="${DB_NAME:-inbox}"
L() { npx -y layero@latest "$@"; }
sql() { L db sql "$DB_NAME" --org "$LAYERO_ORG" -c "$1" --json | tail -1 | jq -r '.rows[0][0] // empty'; }

OWNER=$(sql "select id from auth.users where email = lower('$OWNER_EMAIL')")
OTHER=$(sql "select id from auth.users where email = lower('$OTHER_EMAIL')")
MEMBER=""; [ -n "${MEMBER_EMAIL:-}" ] && MEMBER=$(sql "select id from auth.users where email = lower('$MEMBER_EMAIL')")
SITE=$(sql "select id from public.sites where owner_id = '$OWNER' order by created_at limit 1")
REPORT=$(sql "select id from public.reports where site_id = '$SITE' order by created_at desc limit 1")
[ -n "$OWNER" ] && [ -n "$OTHER" ] && [ -n "$SITE" ] && [ -n "$REPORT" ] || {
  echo "нужны: оба пользователя, сайт владельца и хотя бы одно сообщение" >&2; exit 1; }

pass=0; fail=0
# check <описание> <ожидание: код или код:строк> <метод> <путь> [аргументы probe…]
check() {
  local what=$1 want=$2; shift 2
  local out code rows got
  out=$(L data probe "$@" --db "$DB_NAME" --org "$LAYERO_ORG" --json | tail -1)
  code=$(jq -r '.status' <<<"$out")
  rows=$(jq -r 'if (.body | type) == "array" then (.body | length | tostring) else "" end' <<<"$out")
  got=$code; [[ $want == *:* ]] && got="$code:$rows"
  local pad=$(( 44 - ${#what} )); (( pad < 1 )) && pad=1   # printf считает байты, а ${#} — буквы
  if [ "$got" = "$want" ]; then pass=$((pass+1)); printf '  ✓ %s%*s%s\n' "$what" "$pad" '' "$got"
  else fail=$((fail+1)); printf '  ✗ %s%*s ждали %s, получили %s\n' "$what" "$pad" '' "$want" "$got"; fi
}

echo "Посетитель сайта (публичный ключ)"
check "не читает сообщения"                       401      GET  /rest/v1/reports
check "не пишет в таблицу напрямую"               401      POST /rest/v1/reports --body '{"message":"x"}'
check "не видит список сайтов"                    401      GET  /rest/v1/sites

echo "Владелец сайта"
check "видит свой сайт"                           200:1    GET  /rest/v1/sites --as user --user "$OWNER" --query "id=eq.$SITE"
check "меняет статус"                             200:1    PATCH /rest/v1/reports --as user --user "$OWNER" --query "id=eq.$REPORT" --body '{"status":"in_progress"}'
check "не меняет текст сообщения"                 403      PATCH /rest/v1/reports --as user --user "$OWNER" --query "id=eq.$REPORT" --body '{"message":"подмена"}'

echo "Пользователь из другой команды"
check "не видит чужой сайт"                       200:0    GET  /rest/v1/sites --as user --user "$OTHER" --query "id=eq.$SITE"
check "не видит чужое сообщение по id"            200:0    GET  /rest/v1/reports --as user --user "$OTHER" --query "id=eq.$REPORT"
check "не меняет чужое сообщение"                 200:0    PATCH /rest/v1/reports --as user --user "$OTHER" --query "id=eq.$REPORT" --body '{"status":"rejected"}'
check "не удаляет чужой сайт"                     200:0    DELETE /rest/v1/sites --as user --user "$OTHER" --query "id=eq.$SITE"
check "не добавляет себя в чужую команду"             403      POST /rest/v1/site_members --as user --user "$OTHER" --body "{\"site_id\":\"$SITE\",\"user_id\":\"$OTHER\"}"
check "не приглашает себя в чужую команду"           403      POST /rest/v1/invites --as user --user "$OTHER" --body "{\"site_id\":\"$SITE\",\"email\":\"$OTHER_EMAIL\",\"invited_by\":\"$OTHER\"}"
check "не создаёт сайт от имени владельца"        403      POST /rest/v1/sites --as user --user "$OTHER" --body "{\"name\":\"x\",\"owner_id\":\"$OWNER\"}"
check "не видит снимки чужого сайта"              200:0    POST /storage/v1/object/list/screenshots --as user --user "$OTHER" --body "{\"prefix\":\"$SITE/\"}"

if [ -n "$MEMBER" ]; then
  echo "Пользователь из команды сайта"
  check "видит сайт"                              200:1    GET  /rest/v1/sites --as user --user "$MEMBER" --query "id=eq.$SITE"
  check "меняет статус"                           200:1    PATCH /rest/v1/reports --as user --user "$MEMBER" --query "id=eq.$REPORT" --body '{"status":"resolved"}'
  check "не удаляет сообщение — только владелец"  200:0    DELETE /rest/v1/reports --as user --user "$MEMBER" --query "id=eq.$REPORT"
  check "не меняет настройки сайта"               200:0    PATCH /rest/v1/sites --as user --user "$MEMBER" --query "id=eq.$SITE" --body '{"name":"x"}'
fi

echo; echo "Итог: $pass ✓, $fail ✗"
[ "$fail" -eq 0 ]

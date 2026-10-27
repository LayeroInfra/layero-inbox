# Уведомления в Telegram

Сервера, который бы отправлял уведомления, нет. Их отправляет база: функция
`net.http_post` ставит HTTP-запрос в очередь в той же транзакции, и он уходит
после коммита. Это аналог `pg_net` в Supabase. Ответ сохраняется в
`net._http_response`.

## Токен бота — секрет базы

```bash
export TELEGRAM_BOT_TOKEN=…   # от @BotFather
npx layero@latest data secrets set TELEGRAM_BOT_TOKEN --from-env TELEGRAM_BOT_TOKEN --db inbox
```

В SQL токен пишется подстановкой — `{{secrets.TELEGRAM_BOT_TOKEN}}`. Значение
подставляется при отправке запроса, в таблицах и логах его нет:

```sql
select net.http_post(
    url  := 'https://api.telegram.org/bot{{secrets.TELEGRAM_BOT_TOKEN}}/sendMessage',
    body := jsonb_build_object('chat_id', p_chat, 'text', p_text));
```

## Текст и фото

- **Без снимка** — триггер `reports_notify` после вставки сразу отправляет
  текст (`sendMessage`) и ставит `notified_at`.
- **Со снимком** — триггер пропускает сообщение: файла ещё нет. Виджет
  загружает снимок, подписывает ссылку на минуту и зовёт
  `api.notify_screenshot`. Функция проверяет, что ссылка ведёт ровно на
  снимок этого сообщения в этой базе, и отправляет `sendPhoto` — Telegram
  скачивает картинку по ссылке сам. Если загрузка не удалась, уходит текст с
  пометкой.

Повторно уведомить нельзя: функция работает только пока `notified_at` пуст и
сообщению меньше 10 минут.

## Подключение одной кнопкой

Входящих вебхуков у Data API нет, поэтому бот не может сам сообщить базе о
новом чате. Вместо вебхука — опрос, пока владелец на странице:

```
кабинет                          база                              Telegram
  │── rpc telegram_link_start ──▶ код li…, getUpdates ───────────▶
  │   открыть t.me/<бот>?start=li…                       владелец жмёт «Старт»
  │── rpc telegram_link_check (каждые 2 с) ──▶ ищет «/start li…» в ответах
  │                                          getUpdates ─────────▶
  │◀── linked, «Иван Петров» ── записывает chat_id, шлёт «Готово» ▶
```

- Код живёт 15 минут, проверить его может только тот, кто его получил.
- `getUpdates` вызывается с `offset`, поэтому обработанные события Telegram
  не возвращает повторно; последний `update_id` хранится в `inbox_private.tg_state`.
- Ответ на `getUpdates` приходит асинхронно, поэтому `telegram_link_check`
  читает ответы прошлых опросов и запускает следующий не чаще раза в 2 секунды.

Кнопке «Подключить Telegram» нужно имя бота — переменная `VITE_INBOX_TELEGRAM_BOT`
проекта `web`. `scripts/setup.sh` задаёт её из `TELEGRAM_BOT`.

## Что настраивает владелец

- какие типы сообщений присылать в чат (`notify_kinds`);
- «Прислать пробное» — `api.telegram_test`;
- отключение — обнуляет `telegram_chat_id`.

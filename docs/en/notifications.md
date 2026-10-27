# Telegram notifications

There's no server sending notifications. The database sends them:
`net.http_post` queues an HTTP request in the same transaction, and it goes
out after commit — the equivalent of `pg_net` in Supabase. The response is
stored in `net._http_response`.

## The bot token is a database secret

```bash
export TELEGRAM_BOT_TOKEN=…   # from @BotFather
npx layero@latest data secrets set TELEGRAM_BOT_TOKEN --from-env TELEGRAM_BOT_TOKEN --db inbox
```

In SQL the token is a placeholder — `{{secrets.TELEGRAM_BOT_TOKEN}}`. The
value is substituted when the request is sent; it never appears in tables or logs:

```sql
select net.http_post(
    url  := 'https://api.telegram.org/bot{{secrets.TELEGRAM_BOT_TOKEN}}/sendMessage',
    body := jsonb_build_object('chat_id', p_chat, 'text', p_text));
```

## Text and photo

- **No screenshot** — the `reports_notify` trigger sends the text right after
  insert (`sendMessage`) and sets `notified_at`.
- **With a screenshot** — the trigger skips the message: the file isn't there
  yet. The widget uploads it, signs a one-minute URL and calls
  `api.notify_screenshot`. The function checks that the URL points exactly to
  this message's screenshot in this database and sends `sendPhoto` — Telegram
  downloads the image itself. If the upload failed, the text goes out with a note.

You can't notify twice: the function only works while `notified_at` is empty
and the message is under 10 minutes old.

## One-button connect

The Data API has no inbound webhooks, so the bot can't tell the database about
a new chat. Instead of a webhook — polling while the owner is on the page:

```
dashboard                        database                          Telegram
  │── rpc telegram_link_start ──▶ code li…, getUpdates ──────────▶
  │   open t.me/<bot>?start=li…                        owner presses "Start"
  │── rpc telegram_link_check (every 2 s) ──▶ looks for "/start li…" in responses
  │                                          getUpdates ─────────▶
  │◀── linked, "Ivan Petrov" ── saves chat_id, sends "Done" ─────▶
```

- A code lives 15 minutes; only the user who got it can check it.
- `getUpdates` is called with `offset`, so Telegram doesn't return processed
  updates again; the last `update_id` is stored in `inbox_private.tg_state`.
- The `getUpdates` response arrives asynchronously, so `telegram_link_check`
  reads earlier poll responses and starts the next poll at most every 2 seconds.

The "Connect Telegram" button needs the bot name — the `VITE_INBOX_TELEGRAM_BOT`
variable of the `web` project. `scripts/setup.sh` sets it from `TELEGRAM_BOT`.

## What the owner configures

- which message kinds go to the chat (`notify_kinds`);
- "Send a test" — `api.telegram_test`;
- disconnecting clears `telegram_chat_id`.

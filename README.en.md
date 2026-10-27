# Layero Inbox

**Feedback, leads and bookings for any website — without a server of your own.**
A reference app on [Layero](https://layero.ru): Postgres, Data API, user
sign-in, file storage and Telegram notifications.

[Live demo](https://inbox.layero.app) · [Article: how it's built](docs/article/en.md) · [Русский](README.md)

![Layero Inbox landing](docs/img/landing.png)

![Layero Inbox dashboard](docs/img/guide/13-inbox.png)

## What's inside

| | |
|---|---|
| **Widget** `apps/widget` | One `<script>` tag on the customer's site. Three forms: "Report a problem" (with a screenshot), "Leave a request", "Book a slot" (free slots from a schedule). |
| **Dashboard** `apps/web/dashboard` | Email or Yandex ID sign-in, sites, inbox with filters and statuses, team, form and schedule settings, one-button Telegram. |
| **Landing** `apps/web` | Product page with live forms. |
| **Database** `db/migrations` | Tables, RLS, Data API functions, storage policies, notifications via `net.http_post`. |

There's no backend: the browser talks to the [Data API](https://docs.layero.ru/data-api/)
(supabase-js compatible), Postgres RLS policies decide who sees what, and
anything the browser can't be trusted with runs as a database function.

> The UI is in Russian. The code, schema and docs are language-neutral; strings
> live in `apps/web/src/main.js` and `apps/widget/frame.html`.

## Quick start — 10 minutes

You need a Layero account with a shared database (Pro plan) or a dedicated one, and Node 20+.

```bash
git clone https://github.com/LayeroInfra/layero-inbox && cd layero-inbox
npx layero@latest login

# optional — Telegram notifications (token from @BotFather)
export TELEGRAM_BOT_TOKEN=…  TELEGRAM_BOT=my_inbox_bot

LAYERO_ORG=<org> APP_ADDRESS=<address> ./scripts/setup.sh
```

The script creates the database, enables the Data API, auth and storage,
creates a bucket, applies the schema and deploys two projects:
`<address>.layero.app` (landing, dashboard at `/dashboard/`) and
`<address>-widget.layero.app` (widget). Our run took 8 minutes, under a minute
of it for the database ([log](docs/img/setup-run.log)).

Then:

1. Sign up in the dashboard and add a site — it shows the snippet to paste.
2. Paste it before `</body>` on your site.
3. In site settings, press "Connect Telegram" and then "Start" in the bot.
4. Verify access rules: `./scripts/check-access.sh` (see [database.md](docs/en/database.md#verifying-access)).

## Docs

- [Architecture](docs/en/architecture.md) — components, why the widget uses an iframe, what runs where
- [Database and access](docs/en/database.md) — schema, RLS, who can do what, screenshots in a private bucket
- [Widget](docs/en/widget.md) — embedding, forms, function contract
- [Notifications](docs/en/notifications.md) — `net.http_post`, photos to Telegram, one-button connect
- [Article: building Layero Inbox step by step](docs/article/en.md)

## Layout

```
apps/
  web/          landing (/) and dashboard (/dashboard/), Vite + supabase-js
  widget/       embed.js for third-party sites and the iframe form
db/migrations/  0001 schema & RLS · 0002 forms · 0003 storage · 0004 notifications
scripts/
  setup.sh         the whole infrastructure in one command
  check-access.sh  access matrix via layero data probe
docs/
```

## License

MIT — use it as a starting point for your own projects.

# Architecture

Layero Inbox is three static frontends and one database. There's no app
server: all logic the browser can't be trusted with lives in Postgres.

```
 customer's site                   inbox.layero.app            data.layero.ru/<db>
┌──────────────────┐              ┌──────────────────┐        ┌──────────────────────┐
│ <script embed.js>│──iframe──▶   │ widget: frame.html│──RPC──▶│ api.site_form         │
│ button, snapshot │  postMessage │ forms, upload     │──PUT──▶│ api.submit_form       │
└──────────────────┘              └──────────────────┘        │ storage: screenshots │
                                                              │                      │
                                  ┌──────────────────┐        │ RLS: sites, reports, │
               owner, team  ───▶  │ web: /dashboard/ │──REST─▶│ site_members, invites│
                                  │ supabase-js      │──auth─▶│ auth: email, Yandex  │
                                  └──────────────────┘        │                      │
                                                              │ trigger → net.http_post
                                                              └──────────┬───────────┘
                                                                         ▼
                                                                 api.telegram.org
```

## Components

| Layero project | Folder | What it is |
|---|---|---|
| `<address>` | `apps/web` | Vite, two pages: landing `/` and dashboard `/dashboard/`. The dashboard is supabase-js with the public Data API key. |
| `<address>-widget` | `apps/widget` | `embed.js` — a script for third-party sites; `frame.html` — the form, opened in an iframe. |
| database `inbox` | `db/migrations` | Tables, RLS, `api.*` functions, storage policies, notifications. |

Both projects are linked to the database with `--db`: at build time Layero
injects `VITE_LAYERO_DATA_URL` and `VITE_LAYERO_DATA_KEY` (the public key, role
`anon`). The `service_role` secret never reaches the browser, and the app
doesn't need it.

## Why the widget uses an iframe

`embed.js` runs on someone else's domain. If it called the Data API directly:

- CORS would have to allow any origin, while the Data API by default accepts
  requests only from your project addresses;
- the public key and all form logic would live in a foreign page's context,
  where any script could intercept them.

So `embed.js` only draws the button, takes a screenshot (html2canvas-pro only
works in the page's own context) and opens `frame.html` from the widget's
address. Database requests come from the iframe — from "our" origin. The page
and the iframe talk via `postMessage` with an `origin` check:

```
embed.js                         frame.html
   │── open iframe ──────────────▶│
   │◀──────────── li:ready ───────│
   │── context + screenshot ─────▶│
   │◀──────────── li:close ───────│
```

## What runs where

| What | Where | Why there |
|---|---|---|
| Who sees a site's messages | RLS policies `reports_read` etc. | The browser can't be trusted with a `site_id` filter |
| Accepting a visitor's form | `api.submit_form`, SECURITY DEFINER | Visitors can't write to the table — the function checks the site key, form, consent, slot, rate |
| Free booking slots | `inbox_private.free_slots` | One source of truth for the widget and for the booking check |
| Double booking | unique index `reports_booking_slot` | The database resolves a race between two visitors, not the code |
| Who may upload a screenshot | policy on `storage.objects` | The path comes from `submit_form`; upload is allowed once, within 10 minutes |
| Notification | trigger `reports_notify` → `net.http_post` | The request goes out after commit; the bot token is a database secret |
| Invites | `api.accept_invites` | The email comes from `auth.users`, not from the request |

## The `api` schema

The Data API exposes functions from the `api` schema at
`POST /rest/v1/rpc/<name>`. Argument names are the public contract: the client
sends JSON with the same keys. Internal functions live in `inbox_private` and
aren't callable directly.

`npx layero@latest data methods --db inbox` shows which tables and functions
each role can see and warns about risky settings.

## Next

- [Database and access](database.md)
- [Widget](widget.md)
- [Notifications](notifications.md)

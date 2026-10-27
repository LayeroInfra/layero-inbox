# Widget

## Embedding

One line before `</body>`:

```html
<script src="https://inbox-widget.layero.app/embed.js" data-site="st_…" async></script>
```

`st_…` is the site key from the dashboard. It's public: it only lets you open
and submit that site's forms.

| Attribute | Value |
|---|---|
| `data-site` | site key, required |
| `data-form` | which form the floating button opens: `problem` (default), `lead`, `booking` |
| `data-label` | floating button text |
| `data-position` | `right` (default) or `left` |
| `data-button` | `off` — no floating button |

Your own buttons anywhere on the page:

```html
<button data-inbox="lead">Leave a request</button>
<a href="#" data-inbox="booking">Book a call</a>
```

The script guards against double inclusion (`window.__layeroInbox`) and only
enables forms that are switched on in the site settings.

## Three forms

| Form | Fields | What the database checks |
|---|---|---|
| Problem `problem` | text, screenshot (optional) | text isn't empty |
| Lead `lead` | name, contact, comment, consent | contact and consent |
| Booking `booking` | day, slot, name, contact, consent | slot is free, contact and consent |

![Booking form](../img/guide/06-booking.png)

Slots are built from the site schedule (`booking_days`, `booking_from`,
`booking_to`, `booking_slot_minutes`) in the site's time zone, 14 days ahead
and no sooner than 30 minutes from now. The widget shows them in the site's
time zone, so a visitor from another city sees the same time as the owner.

## Submission flow

```
embed.js (page)              frame.html (iframe)                     Data API
 │ button click
 │ html2canvas-pro snapshot
 │── iframe ?site=…&form=… ─▶│
 │◀───────────── li:ready ───│
 │── context + snapshot ────▶│── rpc site_form ──────────────────────▶ forms, slots
 │                           │── rpc submit_form ────────────────────▶ { id, upload_path }
 │                           │── POST storage/v1/object/screenshots/… ▶ file
 │                           │── POST storage/v1/object/sign/… ──────▶ 60 s URL
 │                           │── rpc notify_screenshot ──────────────▶ photo to Telegram
 │◀───────────── li:close ───│
```

The snapshot is taken before the iframe opens, and the widget itself isn't in
it: elements with `data-layero-*` attributes are excluded.

## Function contract

Call `POST https://data.layero.ru/<db>/rest/v1/rpc/<name>` with the header
`apikey: <public key>` and a JSON body.

**`site_form(site_key)`** → `{ name, forms, timezone, slot_minutes, slots[] }`

**`submit_form(...)`** → `{ id, upload_path }`

| Argument | Type | |
|---|---|---|
| `site_key` | text | required |
| `form` | text | `problem`, `lead`, `booking` |
| `message` | text | up to 2000 chars |
| `name`, `contact` | text | up to 120 and 200 chars |
| `booking_at` | timestamptz | ISO string of a slot from `site_form` |
| `consent` | boolean | for lead and booking |
| `page_url`, `user_agent`, `viewport`, `language` | text | context, truncated |
| `has_screenshot` | boolean | return an upload path for the screenshot |

Errors carry a Postgres code in `code`: `22023` — invalid data or a taken slot,
`54000` — more than 30 messages per minute per site.

**`notify_screenshot(report_id, signed_url)`** → `true` if the notification
was sent or wasn't needed.

## Your own forms without the widget

The functions are plain HTTP, so you can call them from your own form — but
only from an origin allowed in Data API CORS (`layero data origins`); by
default those are your Layero project addresses. That's why third-party sites
need the iframe.

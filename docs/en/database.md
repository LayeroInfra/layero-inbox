# Database and access

Four migrations in `db/migrations`, applied in order
(`layero db sql <db> --file …`; `scripts/setup.sh` does this).

| File | What it does |
|---|---|
| `0001_schema.sql` | Tables, membership checks, triggers, RLS |
| `0002_forms.sql` | `api.site_form`, `api.submit_form`, `api.accept_invites`, free slots |
| `0003_storage.sql` | Policies for the private `screenshots` bucket |
| `0004_notifications.sql` | Telegram: text, photo, one-button connect |

Auth must be enabled before the migrations: the `auth` schema and `auth.uid()`
appear after `layero data enable --auth`.

## Tables

| Table | A row is | Key columns |
|---|---|---|
| `sites` | a customer's site | `owner_id`, `site_key` (public widget key), `forms`, schedule `booking_*`, `timezone`, `telegram_chat_id` |
| `site_members` | a user on the site team | `role`: `owner` or `member`; the owner is added by a trigger |
| `invites` | an email invite | `email`, `accepted_at` |
| `reports` | a message from the site | `kind`: `problem`, `lead`, `booking`; `status`; `screenshot_path`; `notified_at` |

A `check` constraint on `reports` requires per-kind fields: a problem needs
text, a lead needs a contact and consent, a booking also needs a time.

## Roles and permissions

| Action | Site visitor (`anon`) | Site team | Site owner |
|---|---|---|---|
| Read sites and messages | — | own sites | own sites |
| Submit a form | `api.submit_form` | `api.submit_form` | `api.submit_form` |
| Change message status | — | yes | yes |
| Change message text | — | — | — |
| Delete a message | — | — | yes |
| Site settings, invites, Telegram | — | — | yes |
| View screenshots | only their own, for 1 minute — for Telegram | yes | yes |

How it works:

- **Visitors can't touch the tables at all** — `revoke all … from anon`. All
  they can do is call two functions.
- **Inserts into `reports` are closed** even for signed-in users: only via
  `api.submit_form`.
- **Only the status can change**: `grant update (status)` — a column-level
  privilege. Trying to change `message` gets a `403`, not a silent zero rows.
- **Membership checks are SECURITY DEFINER functions** (`inbox_private.is_member`,
  `is_owner`). Otherwise the `sites` policy queries `site_members`, the
  `site_members` policy queries `sites`, and Postgres recurses forever.
- **Only the database writes `site_members`** — a trigger on site creation and
  `api.accept_invites`. You can't join someone else's site by inserting a row.

## SECURITY DEFINER functions: what to watch

Such a function runs with the schema owner's rights and bypasses RLS. So each one:

1. Sets `search_path = public` — so nobody can shadow a table with their own.
2. Trims and validates all input (`left(btrim(...))`, `check`).
3. Checks permissions explicitly: `inbox_private.is_owner(site_id)`, `auth.uid()`.
4. Uses `#variable_conflict use_column` — arguments are named like columns
   (that's the API contract), and without it `site_key = site_key` is always true.

## Screenshots in a private bucket

The `screenshots` bucket is private, up to 5 MB, JPEG and PNG only. The file
path is `<site_id>/<report_id>.jpg`.

1. The widget calls `api.submit_form(…, has_screenshot := true)` and gets an `upload_path`.
2. It uploads the file to that path. The `screenshots_visitor_upload` policy
   allows only the path of a fresh (10 minutes) message that has no file yet.
3. It signs a one-minute URL — `screenshots_visitor_sign` — and passes it to
   `api.notify_screenshot`, so Telegram can fetch the photo.
4. The site team reads screenshots via signed URLs (`screenshots_member_read`);
   the owner can delete them (`screenshots_owner_delete`).

The first folder of the path is the site id; `inbox_private.screenshot_site` extracts it.

## Verifying access

`scripts/check-access.sh` checks permissions through the real Data API gateway:
`layero data probe` runs a request as a visitor or as a specific user and rolls
back any writes.

```bash
LAYERO_ORG=my-team OWNER_EMAIL=me@example.com OTHER_EMAIL=stranger@example.com \
MEMBER_EMAIL=teammate@example.com ./scripts/check-access.sh
```

You need an owner with a site and at least one message, a second user with
their own account and, optionally, a user on the site team who accepted an invite.
The script's output is in Russian; `✓` is a pass.

`200:0` means the request succeeded but RLS filtered out every row. That's how
Postgres answers "not yours": for that user the row simply doesn't exist.

# Closed-Beta Access Control


## What this is


During closed beta, only a curated list of email addresses can sign up to the production app. The public web URL (`app.foliolens.in`) is reachable, but the sign-up step rejects unknown emails. The dev environment stays unrestricted.


## How it works


- A `public.beta_allowlist` table on each Supabase project holds the approved emails.
- A SQL function `public.before_user_created_hook(event jsonb)` runs as a Supabase Auth **before-user-created** hook. It checks the incoming email against the allowlist and returns `{}` (allow) or `{ error: { http_code: 403, message } }` (reject).
- The function has an "empty allowlist = open access" mode: if `beta_allowlist` has zero rows, every signup is allowed. This is what keeps dev unrestricted (we never populate the dev table) and is also the switch to flip from closed beta → public beta later (truncate the prod table).
- The hook is **enabled per project in the dashboard**, not via `config.toml`. Dev leaves it disabled; prod enables it once the migration is applied.


## One-time setup on production (after the migration ships)


1. Open Supabase Dashboard → **prod project (`foliolens`)** → **Authentication** → **Hooks**
2. Click **Add hook** → choose **Before user created**
3. Hook type: **Postgres function**
4. Schema: `public`
5. Function: `before_user_created_hook`
6. Enable the toggle and save


Verify by checking the auth logs after a test signup — a rejected attempt logs the 403 with the function's message.


### Do **not** enable on dev


On the **dev project (`foliolens-dev`)**, leave the same hook disabled. Even if someone accidentally populates the dev `beta_allowlist`, the unset hook means it's never consulted.


## Adding a tester


Supabase Dashboard → prod project → SQL Editor:


    insert into beta_allowlist (email, notes)
    values
      ('newtester@example.com', 'Met at conference 2026-05-04'),
      ('partner@somefirm.in', 'Beta partner');


Or via the table editor in the dashboard. Emails are auto-lowercased on insert.


## Removing a tester


    delete from beta_allowlist where email = 'someone@example.com';


They keep their existing session and data — we don't revoke active sessions. If you want to fully cut off access, also `delete from auth.users where email = 'someone@example.com'`.


## Going public (later)


When you're ready to drop the closed-beta gate:


- Disable the hook in the dashboard (instant), **or**
- Truncate the table: `truncate beta_allowlist;` — the function falls back to "empty = open" mode and signups become free again.


Either works. The toggle is reversible.

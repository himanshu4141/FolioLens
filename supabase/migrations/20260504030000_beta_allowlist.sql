-- Closed-beta access control via Supabase Auth's before_user_created hook.
--
-- The hook is enabled per-project in the Supabase Dashboard
-- (Authentication → Hooks → Before user created → point at
-- public.before_user_created_hook). Leave it DISABLED on the dev
-- project so dev signups stay unrestricted; ENABLE it on prod once
-- this migration has applied and beta_allowlist is populated.
--
-- The function has a deliberate "empty allowlist = open access" mode
-- so that even on prod we can decide later to flip from closed beta
-- to public beta by simply truncating the table.

create table if not exists public.beta_allowlist (
  email text primary key,
  invited_at timestamptz not null default now(),
  invited_by uuid references auth.users(id) on delete set null,
  notes text
);

-- Stored emails are lowercased to match Supabase's normalised form.
create or replace function public.beta_allowlist_lowercase_email()
returns trigger
language plpgsql
as $$
begin
  new.email := lower(trim(new.email));
  return new;
end;
$$;

drop trigger if exists beta_allowlist_lowercase_email_trigger on public.beta_allowlist;
create trigger beta_allowlist_lowercase_email_trigger
  before insert or update on public.beta_allowlist
  for each row
  execute function public.beta_allowlist_lowercase_email();

-- Lock the table down. Inserts/updates only via the service-role key
-- (Supabase Dashboard SQL editor or admin tooling). Authenticated users
-- never need to read it, so deny SELECT outright.
alter table public.beta_allowlist enable row level security;
-- (No policies → service-role still bypasses RLS as designed,
-- everyone else is locked out.)

-- ── before_user_created hook ────────────────────────────────────────────────
-- Receives the new-user event from Supabase Auth and either allows the
-- signup or rejects it with a 403. Empty allowlist → allow everyone.

create or replace function public.before_user_created_hook(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  candidate_email text;
  has_allowlist boolean;
  is_allowed boolean;
begin
  -- The Supabase event nests user fields under `user`. Email may also be
  -- under `email` for some flows (e.g. anonymous → email upgrade), so try
  -- both.
  candidate_email := lower(coalesce(
    (event #>> '{user,email}'),
    (event ->> 'email')
  ));

  if candidate_email is null or candidate_email = '' then
    -- Phone-only or anonymous signups have no email — allow them through.
    -- (We're a Mutual Fund app; phone-only flow is not enabled today, but
    -- this stays defensive in case it lands later.)
    return jsonb_build_object();
  end if;

  select exists(select 1 from public.beta_allowlist limit 1) into has_allowlist;
  if not has_allowlist then
    -- Open mode: no allowlist configured, anyone can sign up.
    return jsonb_build_object();
  end if;

  select exists(
    select 1 from public.beta_allowlist where email = candidate_email
  ) into is_allowed;

  if is_allowed then
    return jsonb_build_object();
  end if;

  return jsonb_build_object(
    'error', jsonb_build_object(
      'http_code', 403,
      'message',
        'FolioLens is in private beta. Email himanshu4141@gmail.com to request access.'
    )
  );
end;
$$;

-- Permissions: only the auth admin role may invoke; lock everyone else out.
revoke all on function public.before_user_created_hook(jsonb) from public, anon, authenticated;
grant execute on function public.before_user_created_hook(jsonb) to supabase_auth_admin;

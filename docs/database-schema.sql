-- Comic30 production schema starter.
-- Use this as the managed database migration target for Postgres.

-- Serverless-compatible state store used by the current API adapter. This preserves
-- the complete Comic30 project graph while the normalized tables below support the
-- longer-term relational migration.
create table if not exists public.comic30_state (
  id text primary key,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.comic30_state enable row level security;

-- No browser-facing policies are intentional. The API accesses this table only
-- with the protected service-role key, which bypasses RLS.
insert into public.comic30_state (id, payload)
values (
  'primary',
  '{"users":[],"sessions":[],"projects":[],"audit":[],"emailTokens":[],"passwordResetTokens":[],"contactProfiles":[],"importBatches":[],"complianceReviews":[]}'::jsonb
)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('comic30-exports', 'comic30-exports', false, 52428800, array['application/zip'])
on conflict (id) do update set public = false;

create table if not exists users (
  id text primary key,
  name text not null,
  email text not null unique,
  password_hash text not null,
  role text not null default 'creator',
  email_verified_at timestamptz,
  compliance_flags jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists sessions (
  token_hash text primary key,
  user_id text not null references users(id) on delete cascade,
  ip text,
  user_agent text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists projects (
  id text primary key,
  owner_id text references users(id) on delete set null,
  slug text not null,
  title text not null,
  payload jsonb not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists audit_events (
  id text primary key,
  user_id text,
  action text not null,
  ip text,
  user_agent text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists contact_profiles (
  id text primary key,
  email text not null unique,
  name text,
  source text not null,
  consent_status text not null,
  consented_at timestamptz,
  tags jsonb not null default '[]'::jsonb,
  profile jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists import_batches (
  id text primary key,
  user_id text references users(id) on delete set null,
  source_name text not null,
  total_rows integer not null default 0,
  consented_rows integer not null default 0,
  duplicate_rows integer not null default 0,
  rejected_rows integer not null default 0,
  mode text not null,
  created_at timestamptz not null default now()
);

create table if not exists compliance_reviews (
  id text primary key,
  user_id text references users(id) on delete set null,
  project_id text references projects(id) on delete set null,
  type text not null,
  status text not null default 'open',
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

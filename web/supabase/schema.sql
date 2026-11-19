-- Game database for the Next.js server.
-- Run this in the Supabase SQL editor. The publishable key cannot run it.
-- Row level security stays on and no browser policy is added, so the
-- publishable key cannot read seat keys or the shoe. The server uses
-- SUPABASE_SECRET_KEY, which bypasses these policies.

create table if not exists public.game_tables (
  id text primary key,
  cluster text not null,
  phase text not null,
  created_at bigint not null,
  document jsonb not null
);

create table if not exists public.game_sessions (
  token text primary key,
  table_id text not null,
  seat integer not null
);

create table if not exists public.game_queue (
  token text primary key,
  document jsonb not null
);

create index if not exists game_tables_cluster_phase on public.game_tables (cluster, phase);

alter table public.game_tables enable row level security;
alter table public.game_sessions enable row level security;
alter table public.game_queue enable row level security;

revoke all on table public.game_tables from anon, authenticated;
revoke all on table public.game_sessions from anon, authenticated;
revoke all on table public.game_queue from anon, authenticated;

grant select, insert, update, delete on table public.game_tables to service_role;
grant select, insert, update, delete on table public.game_sessions to service_role;
grant select, insert, update, delete on table public.game_queue to service_role;

-- One profile per wallet. The browser never writes these tables.
-- Re-running this file leaves the game tables in place.

create table if not exists public.profiles (
  chain text not null,
  address text not null,
  username text not null default '',
  avatar_url text not null default '',
  created_at timestamptz not null default now(),
  primary key (chain, address)
);

create table if not exists public.profile_results (
  hand_id text not null,
  chain text not null,
  address text not null,
  game text not null,
  win boolean not null,
  created_at timestamptz not null default now(),
  primary key (hand_id, chain, address)
);

create index if not exists profile_results_wallet on public.profile_results (chain, address);

alter table public.profiles enable row level security;
alter table public.profile_results enable row level security;

revoke all on table public.profiles from anon, authenticated;
revoke all on table public.profile_results from anon, authenticated;

grant select, insert, update, delete on table public.profiles to service_role;
grant select, insert, update, delete on table public.profile_results to service_role;

-- Table chat. The server writes each line. The browser may only read them,
-- and only through the publishable key, so Realtime can deliver new lines.
-- Seat keys and the shoe stay on game_tables, which this does not grant.

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  table_id text not null,
  name text not null,
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_table_created on public.chat_messages (table_id, created_at);

alter table public.chat_messages enable row level security;

revoke all on table public.chat_messages from anon, authenticated;
grant select on table public.chat_messages to anon, authenticated;
grant select, insert, delete on table public.chat_messages to service_role;

drop policy if exists chat_messages_read on public.chat_messages;
create policy chat_messages_read on public.chat_messages
  for select to anon, authenticated
  using (true);

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'chat_messages'
  ) then
    alter publication supabase_realtime add table public.chat_messages;
  end if;
end $$;

-- House v2 — Migration 001: Insights engine (T4)
-- Run in Supabase SQL Editor after schema.sql

-- ─────────────────────────────────────────────
-- documents.status column
-- pending → processing → done | error
-- Existing rows were already processed → backfill as 'done'
-- ─────────────────────────────────────────────
alter table documents
  add column status text not null default 'pending'
  check (status in ('pending','processing','done','error'));

update documents set status = 'done';

-- ─────────────────────────────────────────────
-- insights_cache — one row per user, 24h TTL enforced in code
-- document_count = qualifying doc count at compute time (Phase 2: replace
-- with content fingerprint cache_key — see TODOS.md)
-- ─────────────────────────────────────────────
create table insights_cache (
  user_id        uuid        primary key references auth.users(id) on delete cascade,
  insights       jsonb       not null default '[]',
  document_count int         not null default 0,
  created_at     timestamptz not null default now()
);

-- ─────────────────────────────────────────────
-- dismissed_insights — persists which insight cards a user has dismissed
-- insight_hash = sha256(biomarker + message)
-- ─────────────────────────────────────────────
create table dismissed_insights (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null references auth.users(id) on delete cascade,
  insight_hash text        not null,
  biomarker    text,
  dismissed_at timestamptz not null default now(),
  unique (user_id, insight_hash)
);

-- ─────────────────────────────────────────────
-- Row Level Security
-- Lambda accesses these via service_role key; user-facing reads allowed
-- ─────────────────────────────────────────────
alter table insights_cache     enable row level security;
alter table dismissed_insights enable row level security;

create policy "users_select_own_insights_cache"
  on insights_cache for select
  using (auth.uid() = user_id);

create policy "users_select_own_dismissed_insights"
  on dismissed_insights for select
  using (auth.uid() = user_id);

-- ─────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────
create index dismissed_insights_user_idx on dismissed_insights(user_id);

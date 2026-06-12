-- House v2 — Migration 002: Health Hub Phase 1 (T12)
-- Run in Supabase SQL Editor AFTER migration-001-insights.sql

-- ─────────────────────────────────────────────
-- user_profiles — baseline questionnaire (all fields optional, PHI)
-- ─────────────────────────────────────────────
create table user_profiles (
  user_id            uuid        primary key references auth.users(id) on delete cascade,
  age                int         check (age between 0 and 130),
  sex                text        check (sex in ('male','female','prefer_not_to_say','other') or sex is null),
  chronic_conditions text[]      default '{}',
  current_medications text[]     default '{}',
  allergies          text[]      default '{}',
  lifestyle_notes    text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- ─────────────────────────────────────────────
-- health_score_cache — Layer 1 (+2) score, one row per user
-- Not PHI (derived metric only)
-- ─────────────────────────────────────────────
create table health_score_cache (
  user_id     uuid        primary key references auth.users(id) on delete cascade,
  score       int         not null check (score between 0 and 100),
  breakdown   jsonb       not null default '{}',
  computed_at timestamptz not null default now()
);

-- Invalidate score cache when a new document is inserted
create or replace function invalidate_health_score_cache()
returns trigger as $$
begin
  delete from health_score_cache where user_id = new.user_id;
  return new;
end;
$$ language plpgsql security definer;

create trigger documents_invalidate_score
  after insert on documents
  for each row execute function invalidate_health_score_cache();

-- ─────────────────────────────────────────────
-- dismissed_insights.served_at — when the dismissed insight was first served
-- (from insights_cache.created_at at dismissal time). Enables the Layer 1
-- "follow-ups acted on" rule: dismissed >=1h after served = reviewed.
-- ─────────────────────────────────────────────
alter table dismissed_insights add column served_at timestamptz;

-- ─────────────────────────────────────────────
-- population_references — NHANES percentiles (Phase 2 seed target)
-- Not PHI (population data)
-- ─────────────────────────────────────────────
create table population_references (
  id             uuid  primary key default gen_random_uuid(),
  canonical_name text  not null,
  age_group      text  not null,
  sex            text  not null,
  p5             float, p25 float, p50 float, p75 float, p95 float
);

create index idx_pop_refs_lookup on population_references (canonical_name, age_group, sex);

-- ─────────────────────────────────────────────
-- Row Level Security
-- ─────────────────────────────────────────────
alter table user_profiles      enable row level security;
alter table health_score_cache enable row level security;
alter table population_references enable row level security;

create policy "users_select_own_profile"
  on user_profiles for select using (auth.uid() = user_id);
create policy "users_insert_own_profile"
  on user_profiles for insert with check (auth.uid() = user_id);
create policy "users_update_own_profile"
  on user_profiles for update using (auth.uid() = user_id);

create policy "users_select_own_score"
  on health_score_cache for select using (auth.uid() = user_id);

-- population_references is public reference data — readable by all authed users
create policy "authed_select_population_references"
  on population_references for select using (auth.role() = 'authenticated');

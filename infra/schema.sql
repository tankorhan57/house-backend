-- House v2 — Supabase schema
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New query)

-- ─────────────────────────────────────────────
-- Documents table
-- ─────────────────────────────────────────────
create table documents (
  id            uuid        primary key,
  user_id       uuid        not null references auth.users(id) on delete cascade,
  s3_key        text        not null,
  file_name     text        not null,
  document_type text        check (document_type in (
                              'blood_panel','mri_report','doctor_note',
                              'specialist_letter','prescription','imaging','other'
                            )),
  date_of_service date,
  provider_name text,
  body_part     text,
  key_findings  jsonb       not null default '[]',
  abnormal_values jsonb     not null default '[]',
  follow_up_recommended boolean default false,
  urgency       text        check (urgency in ('routine','soon','urgent') or urgency is null),
  interpretation text,
  created_at    timestamptz not null default now()
);

-- ─────────────────────────────────────────────
-- Audit log table (HIPAA required)
-- Writes are done via service role key only — users cannot insert or delete
-- ─────────────────────────────────────────────
create table audit_log (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users(id) on delete cascade,
  document_id uuid        references documents(id) on delete set null,
  action      text        not null,
  ip_address  text,
  timestamp   timestamptz not null default now()
);

-- ─────────────────────────────────────────────
-- Row Level Security
-- ─────────────────────────────────────────────
alter table documents  enable row level security;
alter table audit_log  enable row level security;

-- Documents: users can only see and modify their own records
create policy "users_select_own_documents"
  on documents for select
  using (auth.uid() = user_id);

create policy "users_insert_own_documents"
  on documents for insert
  with check (auth.uid() = user_id);

create policy "users_delete_own_documents"
  on documents for delete
  using (auth.uid() = user_id);

-- Audit log: users can read their own entries, but cannot insert/update/delete
-- Lambda writes via service_role key (bypasses RLS) so no insert policy needed
create policy "users_select_own_audit_log"
  on audit_log for select
  using (auth.uid() = user_id);

-- ─────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────
create index documents_user_id_idx          on documents(user_id);
create index documents_user_date_idx        on documents(user_id, date_of_service desc);
create index documents_user_type_date_idx   on documents(user_id, document_type, date_of_service asc);
create index audit_log_user_id_idx         on audit_log(user_id);
create index audit_log_timestamp_idx       on audit_log(timestamp desc);

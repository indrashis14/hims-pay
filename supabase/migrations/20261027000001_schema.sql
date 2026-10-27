-- Base schema for the HIMS fee portal.
-- Every table has RLS on and explicit grants (Supabase stopped auto-granting
-- Data API access to new tables on 2026-10-30).

create extension if not exists pgcrypto with schema extensions;

-- Internal helpers live in `private`, which the Data API does not expose.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

create table public.fee_terms (
  id          bigint generated always as identity primary key,
  name        text not null check (length(btrim(name)) between 1 and 100),
  amount_inr  integer not null check (amount_inr > 0),
  due_date    date not null,
  created_at  timestamptz not null default now()
);

create table public.students (
  id             uuid primary key references auth.users (id) on delete cascade,
  full_name      text not null check (length(btrim(full_name)) between 1 and 120),
  phone          text not null unique check (phone ~ '^[6-9][0-9]{9}$'),
  email          text not null unique,
  -- Students owe the term active at signup and every later one (design §6a).
  first_term_id  bigint not null default 0,
  created_at     timestamptz not null default now()
);

create table public.admins (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now()
);

create table public.term_unblocks (
  student_id    uuid not null references public.students (id) on delete cascade,
  term_id       bigint not null references public.fee_terms (id) on delete cascade,
  unblocked_at  timestamptz not null default now(),
  primary key (student_id, term_id)
);

create type public.order_status as enum ('pending', 'success', 'failed', 'expired');

create table public.orders (
  id              uuid primary key default gen_random_uuid(),
  student_id      uuid not null references public.students (id) on delete cascade,
  term_id         bigint not null references public.fee_terms (id),
  base_inr        integer not null check (base_inr > 0),
  fine_inr        integer not null check (fine_inr >= 0),
  days_late       integer not null check (days_late >= 0),
  total_inr       integer generated always as (base_inr + fine_inr) stored,
  status          public.order_status not null default 'pending',
  pay_token_hash  text not null,
  payer_vpa       text,
  utr             text unique,
  bill_no         text unique,
  failed_reason   text,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  paid_at         timestamptz
);

-- The double-payment guard: one success and one live pending order per student+term.
create unique index orders_one_success on public.orders (student_id, term_id) where status = 'success';
create unique index orders_one_pending on public.orders (student_id, term_id) where status = 'pending';
create index orders_term_status on public.orders (term_id, status);

create sequence private.bill_seq;

-- Reset codes that could not be emailed (outbox mode). Admin-only, purged on expiry.
create table private.reset_outbox (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  email       text not null,
  code        text not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);

alter table public.fee_terms     enable row level security;
alter table public.students      enable row level security;
alter table public.admins        enable row level security;
alter table public.term_unblocks enable row level security;
alter table public.orders        enable row level security;
alter table private.reset_outbox enable row level security;

revoke all on public.fee_terms, public.students, public.admins, public.term_unblocks, public.orders
  from public, anon, authenticated;
revoke all on private.reset_outbox from public, anon, authenticated;
revoke all on sequence private.bill_seq from public, anon, authenticated;

grant select on public.fee_terms, public.students, public.orders to authenticated;
grant all on public.fee_terms, public.students, public.admins, public.term_unblocks, public.orders
  to service_role;
grant all on private.reset_outbox to service_role;
grant usage on sequence private.bill_seq to service_role;

create policy fee_terms_read on public.fee_terms
  for select to authenticated using (true);
create policy students_read_own on public.students
  for select to authenticated using (id = (select auth.uid()));
create policy orders_read_own on public.orders
  for select to authenticated using (student_id = (select auth.uid()));

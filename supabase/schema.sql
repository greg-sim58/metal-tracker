-- MetalTracker — Supabase database schema
--
-- Tables store data ingested from external APIs (gold-api.com, CFTC).
-- Supabase Realtime is enabled on all tables so the dashboard receives
-- live updates via WebSocket subscriptions.
--
-- Run this in the Supabase SQL Editor to create the schema.

-- ---------------------------------------------------------------------------
-- gold_prices — latest gold price snapshots
-- ---------------------------------------------------------------------------

create table if not exists gold_prices (
  id              bigint generated always as identity primary key,
  price           numeric(12, 2) not null,
  currency        text not null default 'USD',
  source_timestamp timestamptz not null,
  created_at      timestamptz not null default now()
);

-- Index for fetching the latest price quickly
create index if not exists idx_gold_prices_created_at
  on gold_prices (created_at desc);

-- Enable Realtime
alter publication supabase_realtime add table gold_prices;

-- ---------------------------------------------------------------------------
-- cot_reports — latest weekly COT report (single most-recent row)
-- ---------------------------------------------------------------------------

create table if not exists cot_reports (
  id                bigint generated always as identity primary key,
  report_date       date not null unique,
  market            text not null default 'Gold Futures',
  open_interest     integer not null,
  commercials_long  integer not null,
  commercials_short integer not null,
  commercials_net   integer not null,
  large_spec_long   integer not null,
  large_spec_short  integer not null,
  large_spec_net    integer not null,
  small_traders_long  integer not null,
  small_traders_short integer not null,
  small_traders_net   integer not null,
  created_at        timestamptz not null default now()
);

create index if not exists idx_cot_reports_report_date
  on cot_reports (report_date desc);

alter publication supabase_realtime add table cot_reports;

-- ---------------------------------------------------------------------------
-- cot_history — 3 years of weekly COT snapshots for percentile analysis
-- ---------------------------------------------------------------------------

create table if not exists cot_history (
  id                bigint generated always as identity primary key,
  report_date       date not null unique,
  managed_money_net integer not null,
  commercials_net   integer not null,
  open_interest     integer not null,
  created_at        timestamptz not null default now()
);

create index if not exists idx_cot_history_report_date
  on cot_history (report_date desc);

alter publication supabase_realtime add table cot_history;

-- ---------------------------------------------------------------------------
-- Row Level Security (RLS)
-- ---------------------------------------------------------------------------
-- All tables are read-only for the anon role.
-- Write access is restricted to the service_role (used by ingestion).

alter table gold_prices enable row level security;
alter table cot_reports enable row level security;
alter table cot_history enable row level security;

-- Anon can read everything
create policy "Allow anon read gold_prices"
  on gold_prices for select
  to anon
  using (true);

create policy "Allow anon read cot_reports"
  on cot_reports for select
  to anon
  using (true);

create policy "Allow anon read cot_history"
  on cot_history for select
  to anon
  using (true);

-- Service role can do everything (used by ingestion API)
create policy "Allow service_role all gold_prices"
  on gold_prices for all
  to service_role
  using (true)
  with check (true);

create policy "Allow service_role all cot_reports"
  on cot_reports for all
  to service_role
  using (true)
  with check (true);

create policy "Allow service_role all cot_history"
  on cot_history for all
  to service_role
  using (true)
  with check (true);

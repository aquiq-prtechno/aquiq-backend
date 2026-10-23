-- AQUIQ: tickets raised by email to r-tickets@ (safe to run more than once)
-- Run this whole file in Supabase -> SQL Editor.

-- 1. Extra ticket columns (only used by email tickets)
alter table tickets add column if not exists contact_email text;                    -- who emailed (shown on unverified tickets)
alter table tickets add column if not exists unverified    boolean not null default false;  -- sender not matched to a store yet

-- 2. Allow the new ticket source "email"
alter table tickets drop constraint if exists tickets_source_check;
alter table tickets add constraint tickets_source_check check (source in ('admin','customer_app','system','email'));

-- 3. Every inbound mail we handled: stops the same mail from being processed twice, and is the audit trail
create table if not exists inbound_emails (
  message_id   text primary key,
  from_email   text,
  subject      text,
  outcome      text,                 -- ticket_created | ticket_unverified | note_added | ignored | rate_limited
  reason       text,
  ticket_id    uuid,
  received_at  timestamptz not null default now()
);
create index if not exists inbound_emails_from_idx on inbound_emails (from_email, received_at desc);
alter table inbound_emails enable row level security;   -- server (service key) only

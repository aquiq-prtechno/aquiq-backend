-- AQUIQ registered engineers (phase 1).  Run ONCE in Supabase -> SQL Editor.
-- Safe to re-run. Needs 2026-10-13_service_tickets.sql to have been run first.
--
-- An engineer can only be given a complaint if they are registered here and 'active'.
-- A blocked engineer's row is never deleted, and phone and ID-proof are unique, so a
-- blocked person cannot register again with the same phone or the same ID document.
-- Engineer IDs (ENG-1001, ENG-1002 ...) come from the same atomic counter as tickets.
--
-- SECURITY: row-level security ON with NO policies. Only the AQUIQ server can read or write.

create table if not exists engineers (
  id             uuid primary key default gen_random_uuid(),
  engineer_code  text not null unique,

  name           text not null,
  phone          text not null,          -- 10-digit mobile, unique
  alt_phone      text,
  address        text,
  city           text,
  state          text,
  pincode        text not null,          -- home base
  latitude       double precision,
  longitude      double precision,
  radius_km      int  not null default 30,
  state_wide     boolean not null default false,
  id_proof_ref   text not null,          -- ID document reference, admin-only

  status         text not null default 'active' check (status in ('active', 'blocked')),
  blocked_reason text,
  blocked_at     timestamptz,
  blocked_by     text,

  registered_by  text,
  auth_user_id   uuid,                   -- set when the engineer app login exists (phase 2)
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create unique index if not exists engineers_phone_uidx   on engineers (phone);
create unique index if not exists engineers_idproof_uidx on engineers (lower(id_proof_ref));
create index        if not exists engineers_status_idx   on engineers (status);
create index        if not exists engineers_pincode_idx  on engineers (pincode);

-- Append-only history of everything done to an engineer record
create table if not exists engineer_events (
  id          bigserial primary key,
  engineer_id uuid not null references engineers (id),
  at          timestamptz not null default now(),
  actor       text not null,
  actor_role  text,
  action      text not null,             -- registered | updated | blocked | restored
  note        text,
  meta        jsonb
);

create index if not exists engineer_events_idx on engineer_events (engineer_id, at);

create or replace function engineer_events_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'engineer_events is append-only';
end;
$$;

drop trigger if exists engineer_events_no_change   on engineer_events;
drop trigger if exists engineer_events_no_truncate on engineer_events;
create trigger engineer_events_no_change
  before update or delete on engineer_events
  for each row execute function engineer_events_append_only();
create trigger engineer_events_no_truncate
  before truncate on engineer_events
  for each statement execute function engineer_events_append_only();

-- Lock: server only
alter table engineers       enable row level security;
alter table engineer_events enable row level security;

revoke all on engineers, engineer_events from anon, authenticated;
grant all on engineers, engineer_events to service_role;
grant usage, select on sequence engineer_events_id_seq to service_role;

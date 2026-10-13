-- AQUIQ service tickets (phase 1).  Run ONCE in Supabase -> SQL Editor.
-- Safe to re-run: every statement is "if not exists" / "or replace".
--
-- Ticket number format:  PMR + YY + 117 + counter + MMDD     e.g. PMR2611790001013
--   PMR = Problem Management Records, YY = year (IST), 117 = A(1) Q(17),
--   counter starts at 9000, MMDD = the date the complaint was raised (IST).
--   The counter NEVER restarts: it runs on across days and across years.
--   Only YY (26 -> 27 on 1 January) and MMDD change. YY + counter are stored as columns;
--   the date suffix is part of ticket_no.
--
-- SECURITY: these tables have row-level security ON with NO policies, so the public
-- (anon) key can neither read nor write them. Only the AQUIQ server (service key) can.

-- 1. Counter (ONE row per series) and the atomic "give me the next number" function
--    The year column is kept only for compatibility and is always 0.
create table if not exists ticket_counters (
  series   text not null,
  year     int  not null,
  last_seq int  not null,
  primary key (series, year)
);

create or replace function next_ticket_seq(p_series text, p_year int, p_start int default 9000)
returns int
language plpgsql
as $$
declare v int;
begin
  -- p_year is ignored on purpose: one continuous counter per series, never reset by the year.
  -- The first call inserts p_start; later calls add 1. The row lock makes this atomic, so two
  -- complaints at the same instant can never receive the same number.
  insert into ticket_counters (series, year, last_seq)
  values (p_series, 0, p_start)
  on conflict (series, year) do update set last_seq = ticket_counters.last_seq + 1
  returning last_seq into v;
  return v;
end;
$$;

-- If a per-year counter row already exists (from an earlier run), carry its highest number
-- into the single continuous row so no number is ever issued twice.
insert into ticket_counters (series, year, last_seq)
select series, 0, max(last_seq) from ticket_counters where year <> 0 group by series
on conflict (series, year) do update
  set last_seq = greatest(ticket_counters.last_seq, excluded.last_seq);

-- 2. Tickets
create table if not exists tickets (
  id               uuid primary key default gen_random_uuid(),
  ticket_no        text not null unique,
  series           text not null default 'PMR',
  year             int  not null,
  seq              int  not null,

  customer_id      uuid,                 -- customers.id (the site)
  device_id        text,

  status           text not null default 'open'
                   check (status in ('open','accepted','arrived','work_done','approved','reopened','closed','cancelled')),
  urgency          text not null default 'normal' check (urgency in ('normal','urgent')),
  source           text not null default 'admin'  check (source in ('admin','customer_app','system')),

  issue_category   text,
  description      text,                 -- the issue exactly as raised

  -- copied at creation, so later edits to the customer record never rewrite history
  site_name        text,
  contact_person   text,
  contact_phone    text,
  address          text,
  pincode          text,
  latitude         double precision,
  longitude        double precision,
  device_snapshot  jsonb,                -- device readings at the moment of the complaint
  raised_by        text,

  engineer_name    text,
  engineer_phone   text,
  engineer_id      uuid,                 -- set once the engineer app exists (phase 2)
  eta_at           timestamptz,          -- promised arrival

  attention_reason text,
  attention_at     timestamptz,

  open_since       timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  accepted_at      timestamptz,
  arrived_at       timestamptz,
  work_done_at     timestamptz,
  approved_at      timestamptz,
  closed_at        timestamptz,
  customer_response text,                -- approved | approved_by_admin | not_satisfied
  customer_reason   text,
  closed_reason     text,
  updated_at       timestamptz not null default now(),

  unique (series, year, seq)
);

create index if not exists tickets_status_idx   on tickets (status);
create index if not exists tickets_customer_idx on tickets (customer_id);
create index if not exists tickets_created_idx  on tickets (created_at desc);

-- 3. Audit trail: append-only. Nobody (including the server) can edit or delete a row.
create table if not exists ticket_events (
  id          bigserial primary key,
  ticket_id   uuid not null references tickets (id),
  at          timestamptz not null default now(),
  actor       text not null,
  actor_role  text,
  action      text not null,
  from_status text,
  to_status   text,
  note        text,
  meta        jsonb
);

create index if not exists ticket_events_ticket_idx on ticket_events (ticket_id, at);

create or replace function ticket_events_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'ticket_events is append-only';
end;
$$;

drop trigger if exists ticket_events_no_change   on ticket_events;
drop trigger if exists ticket_events_no_truncate on ticket_events;
create trigger ticket_events_no_change
  before update or delete on ticket_events
  for each row execute function ticket_events_append_only();
create trigger ticket_events_no_truncate
  before truncate on ticket_events
  for each statement execute function ticket_events_append_only();

-- 4. Lock everything: server only
alter table tickets         enable row level security;
alter table ticket_events   enable row level security;
alter table ticket_counters enable row level security;

revoke all on tickets, ticket_events, ticket_counters from anon, authenticated;
revoke execute on function next_ticket_seq(text, int, int) from public, anon, authenticated;

grant all on tickets, ticket_events, ticket_counters to service_role;
grant usage, select on sequence ticket_events_id_seq to service_role;
grant execute on function next_ticket_seq(text, int, int) to service_role;

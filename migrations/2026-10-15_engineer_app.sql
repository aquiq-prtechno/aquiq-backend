-- AQUIQ engineer app (AQUIQ SE-TECH) — server tables.  Run ONCE in Supabase -> SQL Editor.
-- Safe to re-run. Needs 2026-10-13_service_tickets.sql and 2026-10-14_engineers.sql first.
--
-- SECURITY: row-level security ON with NO policies, and the photo bucket is private.
-- Only the AQUIQ server can read or write any of this.

-- Photos an engineer attaches to a job (before / after / extra). Files live in a private bucket.
create table if not exists ticket_photos (
  id          uuid primary key default gen_random_uuid(),
  ticket_id   uuid not null references tickets (id),
  engineer_id uuid references engineers (id),
  kind        text not null check (kind in ('before', 'after', 'other')),
  path        text not null unique,
  mime        text,
  caption     text,
  created_at  timestamptz not null default now()
);
create index if not exists ticket_photos_ticket_idx on ticket_photos (ticket_id, created_at);

-- An engineer who declines a complaint no longer sees it among their offers.
create table if not exists ticket_declines (
  ticket_id   uuid not null references tickets (id),
  engineer_id uuid not null references engineers (id),
  reason      text,
  at          timestamptz not null default now(),
  primary key (ticket_id, engineer_id)
);

-- Phone push-notification tokens (used when push notifications are switched on).
create table if not exists engineer_devices (
  token       text primary key,
  engineer_id uuid not null references engineers (id),
  platform    text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists engineer_devices_eng_idx on engineer_devices (engineer_id);

alter table ticket_photos    enable row level security;
alter table ticket_declines  enable row level security;
alter table engineer_devices enable row level security;

revoke all on ticket_photos, ticket_declines, engineer_devices from anon, authenticated;
grant all on ticket_photos, ticket_declines, engineer_devices to service_role;

-- Private bucket for job photos: images only, 8 MB each.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('job-photos', 'job-photos', false, 8388608,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

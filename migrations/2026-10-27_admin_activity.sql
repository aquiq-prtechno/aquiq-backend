-- AQUIQ: the admin activity trail (safe to run more than once). Run in Supabase -> SQL Editor.
create table if not exists admin_activity (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor_id    uuid,
  actor_email text,
  role        text,                 -- owner | staff (Team (Emp))
  method      text,
  path        text,
  status      int,                  -- the answer given: 200 done, 403 refused ...
  detail      jsonb
);
create index if not exists admin_activity_at_idx on admin_activity (at desc);
alter table admin_activity enable row level security;   -- the server (service key) only

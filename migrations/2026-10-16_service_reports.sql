-- AQUIQ service reports (FSR) + videos on jobs.  Run ONCE in Supabase -> SQL Editor.
-- Safe to re-run. Needs the earlier migrations first.
--
-- SECURITY: RLS ON with NO policies; buckets private. Only the AQUIQ server touches this.

-- 1) Photos AND videos on a job.
alter table ticket_photos add column if not exists media_type text not null default 'photo';
alter table ticket_photos drop constraint if exists ticket_photos_media_type_check;
alter table ticket_photos add constraint ticket_photos_media_type_check check (media_type in ('photo', 'video'));

-- 2) The service report itself (one per ticket).
create table if not exists service_reports (
  id               uuid primary key default gen_random_uuid(),
  ticket_id        uuid not null unique references tickets (id),
  report_no        text not null unique,
  engineer_id      uuid references engineers (id),
  service_name     text,
  data             jsonb not null,          -- everything the engineer filled in
  device_readings  jsonb,                   -- unit readings captured when the report was saved
  approval_mode    text not null check (approval_mode in ('customer', 'admin', 'engineer_override')),
  override_reason  text,
  pdf_path         text,
  email_status     text,                    -- sent | failed | disabled | no_customer_email
  email_to         text[],
  email_error      text,
  emailed_at       timestamptz,
  created_at       timestamptz not null default now()
);
create index if not exists service_reports_created_idx on service_reports (created_at desc);

alter table service_reports enable row level security;
revoke all on service_reports from anon, authenticated;
grant all on service_reports to service_role;

-- 3) Private bucket for the report PDFs.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('service-reports', 'service-reports', false, 15728640, array['application/pdf'])
on conflict (id) do update set public = false;

-- 4) Job media bucket now also accepts short videos (50 MB each).
update storage.buckets
   set file_size_limit = 52428800,
       allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime']
 where id = 'job-photos';

-- 5) Designation printed under the engineer's name on every service report.
alter table engineers add column if not exists designation text;

-- 6) Engineer's latest position while on the way (for the customer's "how long until they arrive").
alter table tickets add column if not exists eng_lat double precision;
alter table tickets add column if not exists eng_lng double precision;
alter table tickets add column if not exists eng_loc_at timestamptz;

-- 7) 12-month clean-up: remember when a report's photos/videos and PDF were removed.
alter table service_reports add column if not exists media_purged_at timestamptz;
alter table service_reports add column if not exists pdf_purged_at timestamptz;

-- 8) Engineer duty switch, SOP acceptance, and the customer's rating of a finished service.
alter table engineers add column if not exists on_duty boolean not null default true;
alter table engineers add column if not exists sop_version text;
alter table engineers add column if not exists sop_accepted_at timestamptz;
alter table service_reports add column if not exists rating int;
alter table service_reports add column if not exists rating_comment text;
alter table service_reports add column if not exists rated_at timestamptz;

-- 9) A store can add its own email (confirmed with a code) so service updates and reports reach it.
alter table customers add column if not exists email text;
alter table customers add column if not exists email_verified_at timestamptz;

-- 10) Company (UHAD) passwords are kept as a salted hash. The old plain-text column is emptied
--     account by account, as each one logs in or sets a new password.
alter table uhads add column if not exists password_hash text;

-- 11) Which release of the app each account / engineer is running (so old versions can be spotted).
alter table customers add column if not exists app_version text;
alter table customers add column if not exists app_seen_at timestamptz;
alter table uhads add column if not exists app_version text;
alter table uhads add column if not exists app_seen_at timestamptz;
alter table engineers add column if not exists app_version text;
alter table engineers add column if not exists app_seen_at timestamptz;

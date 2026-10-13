-- AQUIQ engineer ID proof: document type + attached scan/photo.  Run ONCE in Supabase -> SQL Editor.
-- Safe to re-run. Needs 2026-10-14_engineers.sql to have been run first.
--
-- The scan is kept in a PRIVATE storage bucket: no public link, no access for the public key.
-- Only the AQUIQ server can read it, and it hands admin a link that expires after 5 minutes.

alter table engineers
  add column if not exists id_proof_type text not null default 'other'
    check (id_proof_type in ('driving_licence', 'aadhaar', 'pan', 'other')),
  add column if not exists id_proof_other text,          -- document name, written by admin when type = other
  add column if not exists proof_path text,              -- location of the attached scan/photo
  add column if not exists proof_file_name text,
  add column if not exists proof_mime text,
  add column if not exists proof_uploaded_at timestamptz;

-- Same number on two different document types is not a clash; same type + same number is.
drop index if exists engineers_idproof_uidx;
create unique index if not exists engineers_idproof_type_uidx
  on engineers (id_proof_type, lower(id_proof_ref));

-- Private bucket: photos and PDFs only, 5 MB each.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('engineer-docs', 'engineer-docs', false, 5242880,
        array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

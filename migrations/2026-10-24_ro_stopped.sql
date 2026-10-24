-- AQUIQ: "Your RO has stopped" notice (safe to run more than once). Run in Supabase -> SQL Editor.
alter table customers add column if not exists pump_off_since       timestamptz;   -- when the pump was first seen OFF (null while running)
alter table customers add column if not exists pump_off_notified_at timestamptz;   -- when the customer was told for this stop

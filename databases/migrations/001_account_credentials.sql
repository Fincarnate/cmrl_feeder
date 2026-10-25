-- Backward-compatible account credential support. Existing records stay intact.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE driver ADD COLUMN IF NOT EXISTS email VARCHAR(150);
ALTER TABLE driver ADD COLUMN IF NOT EXISTS password_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS driver_email_unique_idx ON driver (LOWER(email)) WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS driver_telemetry_trip_recorded_idx ON driver_telemetry (trip_id, recorded_at DESC);

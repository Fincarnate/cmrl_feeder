BEGIN;

ALTER TABLE booking ADD COLUMN IF NOT EXISTS booking_intent VARCHAR(20) NOT NULL DEFAULT 'BOOKING';
ALTER TABLE booking ADD COLUMN IF NOT EXISTS origin_location GEOMETRY(Point,4326);
ALTER TABLE booking ADD COLUMN IF NOT EXISTS origin_location_source VARCHAR(12) NOT NULL DEFAULT 'MANUAL';
ALTER TABLE booking ADD COLUMN IF NOT EXISTS gps_verified_at TIMESTAMPTZ;
ALTER TABLE booking ADD COLUMN IF NOT EXISTS pickup_acknowledged BOOLEAN NOT NULL DEFAULT FALSE;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='booking_intent_valid') THEN
    ALTER TABLE booking ADD CONSTRAINT booking_intent_valid CHECK (booking_intent IN ('BOOKING','DIRECT'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='booking_origin_source_valid') THEN
    ALTER TABLE booking ADD CONSTRAINT booking_origin_source_valid CHECK (origin_location_source IN ('GPS','MANUAL'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS booking_origin_location_gix ON booking USING GIST(origin_location);

COMMIT;

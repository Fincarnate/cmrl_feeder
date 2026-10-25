BEGIN;

-- DRT engine: preserve existing rows and relax fields needed for a pending queue.
ALTER TABLE trip ALTER COLUMN driver_id DROP NOT NULL;
ALTER TABLE trip ALTER COLUMN zone_id DROP NOT NULL;
ALTER TABLE booking ALTER COLUMN trip_id DROP NOT NULL;
ALTER TABLE booking ALTER COLUMN start_point_id DROP NOT NULL;
ALTER TABLE booking ALTER COLUMN group_point_id DROP NOT NULL;

ALTER TABLE driver ADD COLUMN IF NOT EXISTS current_location GEOMETRY(Point, 4326);
ALTER TABLE driver ADD COLUMN IF NOT EXISTS location_recorded_at TIMESTAMPTZ;
ALTER TABLE driver ADD COLUMN IF NOT EXISTS is_online BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE trip ADD COLUMN IF NOT EXISTS station_id UUID REFERENCES metro_station(station_id);
ALTER TABLE trip ADD COLUMN IF NOT EXISTS vehicle_id UUID REFERENCES vehicle(vehicle_id);
ALTER TABLE trip ADD COLUMN IF NOT EXISTS seat_capacity INTEGER;
ALTER TABLE trip ADD COLUMN IF NOT EXISTS dispatch_deadline TIMESTAMPTZ;
ALTER TABLE trip ADD COLUMN IF NOT EXISTS dispatch_started_at TIMESTAMPTZ;
ALTER TABLE trip ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ;
ALTER TABLE trip ADD COLUMN IF NOT EXISTS dispatch_policy JSONB;
ALTER TABLE trip ADD COLUMN IF NOT EXISTS dispatch_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trip ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE trip ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE booking ADD COLUMN IF NOT EXISTS direction VARCHAR(40);
ALTER TABLE booking ADD COLUMN IF NOT EXISTS station_id UUID REFERENCES metro_station(station_id);
ALTER TABLE booking ADD COLUMN IF NOT EXISTS zone_id UUID REFERENCES service_zone(zone_id);
ALTER TABLE booking ADD COLUMN IF NOT EXISTS service_point_id UUID REFERENCES service_point(point_id);
ALTER TABLE booking ADD COLUMN IF NOT EXISTS booking_status VARCHAR(30) NOT NULL DEFAULT 'REQUESTED';
ALTER TABLE booking ALTER COLUMN fare_amount TYPE NUMERIC(12,2) USING fare_amount::NUMERIC(12,2);
ALTER TABLE booking ADD COLUMN IF NOT EXISTS fare_breakdown JSONB;
ALTER TABLE booking ADD COLUMN IF NOT EXISTS fare_policy_version INTEGER;
ALTER TABLE booking ADD COLUMN IF NOT EXISTS distance_km NUMERIC(10,3);
ALTER TABLE booking ADD COLUMN IF NOT EXISTS distance_source VARCHAR(40);
ALTER TABLE booking ADD COLUMN IF NOT EXISTS fare_currency CHAR(3) NOT NULL DEFAULT 'INR';
ALTER TABLE booking ADD COLUMN IF NOT EXISTS requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE booking ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(100);
ALTER TABLE booking ADD COLUMN IF NOT EXISTS driver_arrived_at TIMESTAMPTZ;
ALTER TABLE booking ADD COLUMN IF NOT EXISTS boarding_deadline TIMESTAMPTZ;
ALTER TABLE booking ADD COLUMN IF NOT EXISTS boarding_policy JSONB;
ALTER TABLE booking ADD COLUMN IF NOT EXISTS boarded_at TIMESTAMPTZ;
ALTER TABLE booking ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE booking ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE booking ADD COLUMN IF NOT EXISTS otp_hash TEXT;
ALTER TABLE booking ADD COLUMN IF NOT EXISTS otp_created_at TIMESTAMPTZ;
ALTER TABLE booking ADD COLUMN IF NOT EXISTS otp_expires_at TIMESTAMPTZ;
ALTER TABLE booking ADD COLUMN IF NOT EXISTS otp_used_at TIMESTAMPTZ;
ALTER TABLE booking ADD COLUMN IF NOT EXISTS otp_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trip_stop_sequence ADD COLUMN IF NOT EXISTS station_id UUID REFERENCES metro_station(station_id);
ALTER TABLE trip_stop_sequence ADD COLUMN IF NOT EXISTS stop_type VARCHAR(20) NOT NULL DEFAULT 'SERVICE_POINT';
ALTER TABLE trip_stop_sequence ADD COLUMN IF NOT EXISTS arrived_at TIMESTAMPTZ;
ALTER TABLE trip_stop_sequence ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE trip_stop_sequence ALTER COLUMN point_id DROP NOT NULL;
ALTER TABLE booking ADD COLUMN IF NOT EXISTS final_fare NUMERIC(12,2);

-- Database guards for all newly written DRT rows; legacy rows are validated
-- separately so a migration does not fail on historical records.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='booking_seats_reserved_positive') THEN
        ALTER TABLE booking ADD CONSTRAINT booking_seats_reserved_positive CHECK (seats_reserved > 0) NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='booking_fare_nonnegative') THEN
        ALTER TABLE booking ADD CONSTRAINT booking_fare_nonnegative CHECK (fare_amount IS NULL OR fare_amount >= 0) NOT VALID;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='vehicle_capacity_positive') THEN
        ALTER TABLE vehicle ADD CONSTRAINT vehicle_capacity_positive CHECK (max_capacity IS NULL OR max_capacity > 0) NOT VALID;
    END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS trip_stop_sequence_unique_order ON trip_stop_sequence(trip_id, stop_sequence);

CREATE TABLE IF NOT EXISTS drt_fare_policy (
    version INTEGER PRIMARY KEY,
    currency CHAR(3) NOT NULL DEFAULT 'INR',
    base_fare NUMERIC(12,2) NOT NULL CHECK (base_fare >= 0),
    per_km_rate NUMERIC(12,2) NOT NULL CHECK (per_km_rate >= 0),
    minimum_fare NUMERIC(12,2) NOT NULL CHECK (minimum_fare >= 0),
    booking_fee NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (booking_fee >= 0),
    peak_multiplier NUMERIC(6,4) NOT NULL DEFAULT 1 CHECK (peak_multiplier > 0),
    offpeak_multiplier NUMERIC(6,4) NOT NULL DEFAULT 1 CHECK (offpeak_multiplier > 0),
    direction_rates JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS drt_one_active_fare_policy ON drt_fare_policy ((is_active)) WHERE is_active;
INSERT INTO drt_fare_policy(version, base_fare, per_km_rate, minimum_fare, booking_fee)
VALUES (1, 20.00, 8.00, 25.00, 0.00) ON CONFLICT (version) DO NOTHING;

CREATE TABLE IF NOT EXISTS drt_operating_policy (
    version INTEGER PRIMARY KEY,
    timezone VARCHAR(80) NOT NULL DEFAULT 'Asia/Kolkata',
    operating_days SMALLINT[] NOT NULL DEFAULT ARRAY[1,2,3,4,5,6,7],
    peak_periods JSONB NOT NULL DEFAULT '[{"start":"07:00","end":"10:00"},{"start":"16:30","end":"20:30"}]'::jsonb,
    peak_dispatch_wait_minutes INTEGER NOT NULL DEFAULT 5 CHECK (peak_dispatch_wait_minutes > 0),
    offpeak_dispatch_wait_minutes INTEGER NOT NULL DEFAULT 8 CHECK (offpeak_dispatch_wait_minutes > 0),
    peak_boarding_grace_minutes INTEGER NOT NULL DEFAULT 2 CHECK (peak_boarding_grace_minutes > 0),
    offpeak_boarding_grace_minutes INTEGER NOT NULL DEFAULT 4 CHECK (offpeak_boarding_grace_minutes > 0),
    otp_validity_minutes INTEGER NOT NULL DEFAULT 5 CHECK (otp_validity_minutes > 0),
    otp_max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (otp_max_attempts > 0),
    driver_location_max_age_seconds INTEGER NOT NULL DEFAULT 90 CHECK (driver_location_max_age_seconds > 0),
    minimum_dispatch_passengers INTEGER NOT NULL DEFAULT 1 CHECK (minimum_dispatch_passengers > 0),
    maximum_vehicle_capacity INTEGER NOT NULL DEFAULT 8 CHECK (maximum_vehicle_capacity > 0),
    dispatch_retry_minutes INTEGER NOT NULL DEFAULT 1 CHECK (dispatch_retry_minutes > 0),
    dispatch_max_attempts INTEGER NOT NULL DEFAULT 8 CHECK (dispatch_max_attempts > 0),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS drt_one_active_operating_policy ON drt_operating_policy ((is_active)) WHERE is_active;
INSERT INTO drt_operating_policy(version) VALUES (1) ON CONFLICT (version) DO NOTHING;

CREATE TABLE IF NOT EXISTS drt_engine_event (
    event_id BIGSERIAL PRIMARY KEY,
    event_type VARCHAR(60) NOT NULL,
    trip_id UUID REFERENCES trip(trip_id),
    booking_id UUID REFERENCES booking(booking_id),
    actor_role VARCHAR(20),
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS booking_queue_idx ON booking(booking_status, direction, station_id, zone_id, requested_at);
CREATE UNIQUE INDEX IF NOT EXISTS booking_idempotency_idx ON booking(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS trip_dispatch_queue_idx ON trip(trip_status, dispatch_deadline);
CREATE UNIQUE INDEX IF NOT EXISTS trip_active_driver_idx ON trip(driver_id) WHERE driver_id IS NOT NULL AND UPPER(trip_status) IN ('DISPATCHED','IN_PROGRESS');
CREATE UNIQUE INDEX IF NOT EXISTS trip_active_vehicle_idx ON trip(vehicle_id) WHERE vehicle_id IS NOT NULL AND UPPER(trip_status) IN ('DISPATCHED','IN_PROGRESS');
CREATE INDEX IF NOT EXISTS driver_location_gix ON driver USING GIST(current_location);
CREATE INDEX IF NOT EXISTS station_boundary_gix ON metro_station USING GIST(service_boundary_polygon);
CREATE INDEX IF NOT EXISTS zone_boundary_gix ON service_zone USING GIST(boundary_polygon);
CREATE INDEX IF NOT EXISTS service_point_location_gix ON service_point USING GIST(location_coords);
CREATE INDEX IF NOT EXISTS trip_stop_order_idx ON trip_stop_sequence(trip_id, stop_sequence);
CREATE INDEX IF NOT EXISTS booking_boarding_deadline_idx ON booking(booking_status, boarding_deadline);

COMMIT;

BEGIN;

CREATE TABLE IF NOT EXISTS recurring_booking_schedule (
    schedule_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id),
    direction VARCHAR(40) NOT NULL CHECK (direction IN ('RESIDENTIAL_TO_METRO','METRO_TO_RESIDENTIAL')),
    station_id UUID NOT NULL REFERENCES metro_station(station_id),
    zone_id UUID NOT NULL REFERENCES service_zone(zone_id),
    service_point_id UUID NOT NULL REFERENCES service_point(point_id),
    seats_reserved INTEGER NOT NULL CHECK (seats_reserved BETWEEN 1 AND 8),
    daily_departure_time TIME NOT NULL,
    timezone VARCHAR(80) NOT NULL,
    origin_location_source VARCHAR(12) NOT NULL CHECK (origin_location_source IN ('GPS','MANUAL')),
    pickup_acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
    idempotency_key VARCHAR(100),
    schedule_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE' CHECK (schedule_status IN ('ACTIVE','CANCELLED')),
    next_service_date DATE,
    next_departure_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    cancelled_at TIMESTAMPTZ,
    CONSTRAINT recurring_schedule_next_state CHECK (
        (schedule_status='ACTIVE' AND next_service_date IS NOT NULL AND next_departure_at IS NOT NULL AND cancelled_at IS NULL)
        OR (schedule_status='CANCELLED' AND next_service_date IS NULL AND next_departure_at IS NULL AND cancelled_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS recurring_schedule_idempotency_idx
    ON recurring_booking_schedule(user_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS recurring_schedule_due_idx
    ON recurring_booking_schedule(next_departure_at,schedule_id) WHERE schedule_status='ACTIVE';
CREATE INDEX IF NOT EXISTS recurring_schedule_user_idx
    ON recurring_booking_schedule(user_id,created_at DESC);

CREATE TABLE IF NOT EXISTS recurring_booking_occurrence (
    occurrence_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    schedule_id UUID NOT NULL REFERENCES recurring_booking_schedule(schedule_id),
    service_date DATE NOT NULL,
    scheduled_at TIMESTAMPTZ NOT NULL,
    occurrence_status VARCHAR(16) NOT NULL CHECK (occurrence_status IN ('CREATED','MISSED')),
    booking_id UUID UNIQUE REFERENCES booking(booking_id),
    trip_id UUID REFERENCES trip(trip_id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT recurring_occurrence_unique_date UNIQUE(schedule_id,service_date),
    CONSTRAINT recurring_occurrence_created_state CHECK (
        (occurrence_status='CREATED' AND booking_id IS NOT NULL AND trip_id IS NOT NULL)
        OR (occurrence_status='MISSED' AND booking_id IS NULL AND trip_id IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS recurring_occurrence_schedule_history_idx
    ON recurring_booking_occurrence(schedule_id,service_date DESC);
CREATE INDEX IF NOT EXISTS recurring_occurrence_trip_idx
    ON recurring_booking_occurrence(trip_id) WHERE trip_id IS NOT NULL;

COMMIT;

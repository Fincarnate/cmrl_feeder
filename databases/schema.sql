
CREATE TABLE IF NOT EXISTS admins (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role VARCHAR(20) DEFAULT 'ADMIN',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- Metro station (changed logic)

CREATE TABLE metro_station (
    station_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    station_name VARCHAR(100) NOT NULL,
    station_coords GEOMETRY(Point, 4326),
    service_boundary_polygon GEOMETRY(Polygon, 4326),
    service_area_polygon GEOMETRY(Polygon, 4326),
    service_radius_km NUMERIC(8,2),
    station_geofence_radius_m NUMERIC(8,2),
    service_area_source VARCHAR(40),
    station_center_source VARCHAR(80),
    station_geofence_source VARCHAR(40),
    geometry_updated_at TIMESTAMPTZ,

    feeder_bay_number INT,
    is_active BOOLEAN DEFAULT TRUE
);


-- Service zone

CREATE TABLE service_zone (
    zone_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    station_id UUID NOT NULL,
    zone_name VARCHAR(100) NOT NULL,
    zone_type VARCHAR(20),
    boundary_polygon GEOMETRY(Polygon, 4326),
    center_coords GEOMETRY(Point,4326),
    service_radius_km NUMERIC(8,2),
    boundary_source VARCHAR(40),
    center_source VARCHAR(80),
    geometry_updated_at TIMESTAMPTZ,
    distance_to_metro_km DECIMAL(6,2),
    has_unassigned_queue BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,

    CONSTRAINT fk_zone_station
        FOREIGN KEY (station_id)
        REFERENCES metro_station(station_id)
);

-- User

CREATE TABLE users (
    user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_number VARCHAR(15) UNIQUE NOT NULL,
    full_name VARCHAR(100) NOT NULL,
    email VARCHAR(150) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);


-- Driver

CREATE TABLE driver (
    driver_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    active_zone_id UUID,
    phone_number VARCHAR(15) UNIQUE NOT NULL,
    full_name VARCHAR(100) NOT NULL,
    email VARCHAR(150) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    driving_license_no VARCHAR(50) UNIQUE NOT NULL,
    current_service_mode VARCHAR(30),
    shift_status VARCHAR(30),
    kyc_type VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_driver_zone
        FOREIGN KEY (active_zone_id)
        REFERENCES service_zone(zone_id)
);

-- Service Point

CREATE TABLE service_point (
    point_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    zone_id UUID NOT NULL,
    point_name VARCHAR(100) NOT NULL,
    location_coords GEOMETRY(Point, 4326),
    road_access_status VARCHAR(30),
    is_hub_stop BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    verification_status VARCHAR(20) NOT NULL DEFAULT 'UNVERIFIED' CHECK (verification_status IN ('UNVERIFIED','VERIFIED')),
    coordinate_source VARCHAR(80),
    CONSTRAINT service_point_verified_source_required CHECK (verification_status <> 'VERIFIED' OR coordinate_source IS NOT NULL),

    CONSTRAINT fk_point_zone
        FOREIGN KEY (zone_id)
        REFERENCES service_zone(zone_id)
);


-- Vehicle

CREATE TABLE vehicle (
    vehicle_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id UUID NOT NULL,
    registration_no VARCHAR(30) UNIQUE NOT NULL,
    max_capacity INT,
    fuel_type VARCHAR(30),
    is_frozen_until BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,

    CONSTRAINT fk_vehicle_driver
        FOREIGN KEY (driver_id)
        REFERENCES driver(driver_id)
);


CREATE TABLE trip (
    trip_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    zone_id UUID NOT NULL,
    driver_id UUID NOT NULL,
    trip_direction VARCHAR(50),
    service_mode VARCHAR(50),
    departure_time TIMESTAMP,
    available_seats INT CHECK (available_seats >= 0),
    trip_status VARCHAR(30),

    CONSTRAINT fk_trip_zone
        FOREIGN KEY (zone_id)
        REFERENCES service_zone(zone_id),

    CONSTRAINT fk_trip_driver
        FOREIGN KEY (driver_id)
        REFERENCES driver(driver_id)
);


CREATE TABLE booking (
    booking_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    trip_id UUID NOT NULL,
    start_point_id UUID NOT NULL,
    group_point_id UUID NOT NULL,
    seats_reserved INT CHECK (seats_reserved > 0),
    fare_amount DECIMAL(10,2),
    booking_status VARCHAR(30),
    booking_otp VARCHAR(10),
    qr_code_token VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_booking_user
        FOREIGN KEY (user_id)
        REFERENCES users(user_id),

    CONSTRAINT fk_booking_trip
        FOREIGN KEY (trip_id)
        REFERENCES trip(trip_id),

    CONSTRAINT fk_booking_start_point
        FOREIGN KEY (start_point_id)
        REFERENCES service_point(point_id),

    CONSTRAINT fk_booking_group_point
        FOREIGN KEY (group_point_id)
        REFERENCES service_point(point_id)
);


CREATE TABLE trip_stop_sequence (
    stop_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trip_id UUID NOT NULL,
    point_id UUID NOT NULL,
    stop_sequence INT NOT NULL,
    scheduled_eta TIMESTAMP,
    stop_status VARCHAR(30),

    CONSTRAINT fk_stop_trip
        FOREIGN KEY (trip_id)
        REFERENCES trip(trip_id),

    CONSTRAINT fk_stop_point
        FOREIGN KEY (point_id)
        REFERENCES service_point(point_id)
);



CREATE TABLE driver_telemetry (
    telemetry_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trip_id UUID NOT NULL,
    current_location GEOMETRY(Point, 4326),
    speed_kmph FLOAT,
    heading_degrees FLOAT,
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_telemetry_trip
        FOREIGN KEY (trip_id)
        REFERENCES trip(trip_id)
);

CREATE INDEX IF NOT EXISTS driver_telemetry_trip_recorded_idx ON driver_telemetry (trip_id, recorded_at DESC);


CREATE TABLE driver_payout (
    payout_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id UUID NOT NULL,
    shift_date DATE NOT NULL,
    completed_trips INT DEFAULT 0,
    gross_fare_collected DECIMAL(10,2),
    net_guarantee_topup DECIMAL(10,2),
    net_payable_amount DECIMAL(10,2),
    payout_status VARCHAR(30),

    CONSTRAINT fk_payout_driver
        FOREIGN KEY (driver_id)
        REFERENCES driver(driver_id)
);

CREATE TABLE payment (
    payment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID UNIQUE NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    payment_mode VARCHAR(30),
    payment_status VARCHAR(30),
    transaction_ref VARCHAR(100),
    paid_at TIMESTAMP,

    CONSTRAINT fk_payment_booking
        FOREIGN KEY (booking_id)
        REFERENCES booking(booking_id)
);

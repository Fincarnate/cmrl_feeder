BEGIN;

ALTER TABLE metro_station ADD COLUMN IF NOT EXISTS service_area_polygon GEOMETRY(Polygon,4326);
ALTER TABLE metro_station ADD COLUMN IF NOT EXISTS service_radius_km NUMERIC(8,2);
ALTER TABLE metro_station ADD COLUMN IF NOT EXISTS station_geofence_radius_m NUMERIC(8,2);
ALTER TABLE metro_station ADD COLUMN IF NOT EXISTS service_area_source VARCHAR(40);
ALTER TABLE metro_station ADD COLUMN IF NOT EXISTS station_center_source VARCHAR(80);
ALTER TABLE metro_station ADD COLUMN IF NOT EXISTS station_geofence_source VARCHAR(40);
ALTER TABLE metro_station ADD COLUMN IF NOT EXISTS geometry_updated_at TIMESTAMPTZ;

ALTER TABLE service_zone ADD COLUMN IF NOT EXISTS center_coords GEOMETRY(Point,4326);
ALTER TABLE service_zone ADD COLUMN IF NOT EXISTS service_radius_km NUMERIC(8,2);
ALTER TABLE service_zone ADD COLUMN IF NOT EXISTS boundary_source VARCHAR(40);
ALTER TABLE service_zone ADD COLUMN IF NOT EXISTS center_source VARCHAR(80);
ALTER TABLE service_zone ADD COLUMN IF NOT EXISTS geometry_updated_at TIMESTAMPTZ;

ALTER TABLE service_point ADD COLUMN IF NOT EXISTS verification_status VARCHAR(20) NOT NULL DEFAULT 'UNVERIFIED';
ALTER TABLE service_point ADD COLUMN IF NOT EXISTS coordinate_source VARCHAR(80);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='service_point_verification_status_valid') THEN
    ALTER TABLE service_point ADD CONSTRAINT service_point_verification_status_valid
      CHECK (verification_status IN ('UNVERIFIED','VERIFIED')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='service_point_verified_source_required') THEN
    ALTER TABLE service_point ADD CONSTRAINT service_point_verified_source_required
      CHECK (verification_status <> 'VERIFIED' OR coordinate_source IS NOT NULL) NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS metro_station_service_area_gix ON metro_station USING GIST(service_area_polygon);
CREATE INDEX IF NOT EXISTS service_zone_center_gix ON service_zone USING GIST(center_coords);
CREATE INDEX IF NOT EXISTS service_point_verified_location_gix ON service_point USING GIST(location_coords)
  WHERE is_active=TRUE AND verification_status='VERIFIED';

COMMIT;

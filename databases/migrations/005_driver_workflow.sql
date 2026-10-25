BEGIN;

ALTER TABLE driver ADD COLUMN IF NOT EXISTS location_accuracy_m NUMERIC(8,2);
ALTER TABLE trip_stop_sequence ADD COLUMN IF NOT EXISTS stop_result VARCHAR(40);
ALTER TABLE trip_stop_sequence ADD COLUMN IF NOT EXISTS stop_result_at TIMESTAMPTZ;

UPDATE driver SET current_service_mode=CASE UPPER(TRIM(current_service_mode))
    WHEN 'R2M' THEN 'RESIDENTIAL_TO_METRO'
    WHEN 'M2R' THEN 'METRO_TO_RESIDENTIAL'
    WHEN 'RESIDENTIAL_TO_METRO' THEN 'RESIDENTIAL_TO_METRO'
    WHEN 'METRO_TO_RESIDENTIAL' THEN 'METRO_TO_RESIDENTIAL'
    ELSE UPPER(TRIM(current_service_mode)) END
WHERE current_service_mode IS NOT NULL;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='driver_location_accuracy_nonnegative') THEN
        ALTER TABLE driver ADD CONSTRAINT driver_location_accuracy_nonnegative
            CHECK (location_accuracy_m IS NULL OR location_accuracy_m >= 0) NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='trip_stop_result_valid') THEN
        ALTER TABLE trip_stop_sequence ADD CONSTRAINT trip_stop_result_valid
            CHECK (stop_result IS NULL OR stop_result IN ('NO_SCHEDULED_PASSENGER','PASSENGERS_RESOLVED','DESTINATIONS_COMPLETED')) NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='trip_stop_target_matches_type') THEN
        ALTER TABLE trip_stop_sequence ADD CONSTRAINT trip_stop_target_matches_type CHECK (
            (stop_type='SERVICE_POINT' AND point_id IS NOT NULL AND station_id IS NULL) OR
            (stop_type='STATION' AND station_id IS NOT NULL AND point_id IS NULL)
        ) NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='trip_stop_type_valid') THEN
        ALTER TABLE trip_stop_sequence ADD CONSTRAINT trip_stop_type_valid CHECK (stop_type IN ('SERVICE_POINT','STATION')) NOT VALID;
    END IF;
END $$;

COMMIT;

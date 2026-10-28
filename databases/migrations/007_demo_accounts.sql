BEGIN;

ALTER TABLE driver ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS driver_demo_mode_idx ON driver(current_service_mode,shift_status) WHERE is_demo=TRUE;
CREATE INDEX IF NOT EXISTS users_demo_idx ON users(user_id) WHERE is_demo=TRUE;

COMMIT;

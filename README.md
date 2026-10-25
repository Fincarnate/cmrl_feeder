# CMRL Feeder

CMRL Feeder is a Fastify, PostgreSQL/PostGIS, and React/Vite application for metro feeder operations. The DRT engine accepts passenger requests, calculates and freezes an itemized quote, groups compatible requests, assigns fresh/available drivers and vehicles, and records booking and trip progress.

## Setup

Install backend and frontend dependencies in their respective directories. Configure `backend/.env` with database connection values and a private `JWT_SECRET`. The backend also accepts `DRT_WORKER_INTERVAL_MS` (defaults to `1000`) and `OTP_DELIVERY_MODE`; development mode allows passenger-authenticated OTP retrieval for local testing, while production defaults to unconfigured and requires a delivery integration before OTP retrieval is available.

Create Postgres with PostGIS, then apply schema and migrations in order:

```powershell
psql -U postgres -d cmrl_feeder -f databases/schema.sql
psql -U postgres -d cmrl_feeder -f databases/migrations/001_account_credentials.sql
psql -U postgres -d cmrl_feeder -f databases/migrations/002_drt_engine.sql
psql -U postgres -d cmrl_feeder -f databases/migrations/003_passenger_journey.sql
```

Migration `002` adds operational fields, indexes, audit events, and versioned fare and operating policies. Its development fare defaults (INR 20 base, INR 8/km, INR 25 minimum, zero fee) are configurable by an authenticated administrator and are not intended as permanent commercial rates. Peak fare multipliers default to `1.0`. The default policy uses Asia/Kolkata, daily service, peak windows 07:00–10:00 and 16:30–20:30, 5/8 minute dispatch waits, 2/4 minute boarding grace, and a five-minute OTP validity. Policies are versioned and timing snapshots are stored when a trip or boarding timer starts.

The fare distance is an estimated straight-line geographic distance because no road-routing provider is configured. It is labeled as an estimate in the API and UI. The application calculates fare only; it does not create payments.

Passenger location is requested only after a travel direction is selected. Location resolution uses longitude/latitude in EPSG:4326 and PostGIS `ST_Covers`; nearest residential-zone recommendations use geodesic distance from the reported point to each eligible polygon (`ST_Distance(geometry::geography, point::geography)`). The passenger must confirm an out-of-zone pickup recommendation. Migration `003` records booking intent and the origin GPS/manual provenance. Geographic service data is intentionally not fabricated; an empty `databases/seed.sql` means booking stays unavailable until legitimate station, zone, and point records are provisioned.

`Booking` creates a regular shared DRT queue request. `Direct Booking` attempts to reserve a fresh online driver and eligible vehicle atomically; it returns an unavailable response without creating a queued booking when no immediate assignment is possible. Both confirm a server-signed, five-minute fare quote and do not initiate payment.

Create an admin when needed by setting `ADMIN_NAME`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD`, then running `node src/scripts/create-admin.js` from `backend`. Driver registration requires the real vehicle passenger capacity; the operating policy caps which registered vehicles can be dispatched.

## Start

Run `npm run dev` in `backend` and `npm run dev` in `frontend`. The frontend API base defaults to `http://localhost:5000/api`; `VITE_API_URL` can override it. The map uses actual station, zone, and service-point geometries and OpenStreetMap tiles; it does not fabricate live passenger or driver positions.

## DRT API

All endpoints use bearer JWT authentication. Passenger routes require a passenger identity, driver routes require a driver identity, and dashboard/policy routes require an admin identity.

- `GET /api/bookings/service-areas`
- `POST /api/bookings/location-resolution` (direction plus numeric latitude/longitude)
- `POST /api/bookings/fare-preview`
- `POST /api/bookings` (optional `Idempotency-Key` header)
- `GET /api/bookings`, `GET /api/bookings/:id`, `POST /api/bookings/:id/cancel`, `GET /api/bookings/:id/otp`
- `GET|POST /api/drivers/availability`, `POST /api/drivers/telemetry`, `GET /api/drivers/trips`
- `POST /api/drivers/trips/:tripId/stops/:stopId/arrival|complete`, `POST /api/drivers/trips/:tripId/start`, `POST /api/drivers/bookings/:bookingId/verify-otp`
- `GET /api/dashboard/operations`, `GET /api/dashboard/policies`, `PATCH /api/dashboard/policies/fare`, `PATCH /api/dashboard/policies/operating`

Seat capacity is reserved transactionally by counting bookings in REQUESTED, ASSIGNED, BOARDING, and IN_PROGRESS states under a per-compatibility advisory lock. Cancellations and no-shows leave those seat-counting states. A persistent database-backed worker handles dispatch deadlines, bounded dispatch retries, OTP expiry, and boarding no-shows. Driver selection uses online status, location freshness, capacity fit, lower daily assignment count, then distance to the first pickup. OTPs are stored as bcrypt hashes; the development retrieval endpoint returns an OTP only after driver arrival and is disabled by default in production.

## Checks

Run `npm test` from `backend` for fare, operating policy, dispatch rules, booking states, and route/authentication checks. Run `npx eslint .` and `npx vite build` from `frontend`. Booking and dispatch integration still requires a reachable PostgreSQL/PostGIS database with the migrations applied and real service-area and driver/vehicle data.

To run the read-only PostgreSQL/PostGIS integration test in PowerShell from `backend`, use `$env:DRT_INTEGRATION_TESTS='1'; node --test test/database.integration.test.js; Remove-Item Env:DRT_INTEGRATION_TESTS`. Database credentials are loaded from `backend/.env`.

changes
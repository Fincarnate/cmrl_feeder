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
psql -U postgres -d cmrl_feeder -f databases/migrations/004_configurable_geographic_service_area.sql
psql -U postgres -d cmrl_feeder -f databases/migrations/005_driver_workflow.sql
psql -U postgres -d cmrl_feeder -f databases/migrations/006_recurring_booking_schedules.sql
psql -U postgres -d cmrl_feeder -f databases/migrations/007_demo_accounts.sql
```

Migration `002` adds operational fields, indexes, audit events, and versioned fare and operating policies. Its development fare defaults (INR 20 base, INR 8/km, INR 25 minimum, zero fee) are configurable by an authenticated administrator and are not intended as permanent commercial rates. Peak fare multipliers default to `1.0`. The default policy uses Asia/Kolkata, daily service, peak windows 07:00–10:00 and 16:30–20:30, 5/8 minute dispatch waits, 2/4 minute boarding grace, and a five-minute OTP validity. Policies are versioned and timing snapshots are stored when a trip or boarding timer starts.

The fare distance is an estimated straight-line geographic distance because no road-routing provider is configured. It is labeled as an estimate in the API and UI. The application calculates fare only; it does not create payments.

Passenger location is requested only after a travel direction is selected. Location resolution uses longitude/latitude in EPSG:4326 and PostGIS `ST_Covers`; nearest residential-zone recommendations use geodesic distance from the reported point to each eligible polygon (`ST_Distance(geometry::geography, point::geography)`). The passenger must confirm an out-of-zone pickup recommendation. Migration `003` records booking intent and the origin GPS/manual provenance. Geographic service data is intentionally not fabricated; an empty `databases/seed.sql` means booking stays unavailable until legitimate station, zone, and point records are provisioned.

`Booking` saves a daily recurring schedule. It does not create a trip at setup time; the worker creates each occurrence when its selected local departure time is due, and records missed departures without replaying them. The passenger can review upcoming departures and occurrence history or cancel the schedule; cancellation keeps existing history. `Direct Booking` is one immediate trip and attempts to reserve a fresh online driver and eligible vehicle atomically. It returns an unavailable response without creating a queued booking when no immediate assignment is possible. Both confirm a server-signed, five-minute fare quote and do not initiate payment.

Create an admin when needed by setting `ADMIN_NAME`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD`, then running `node src/scripts/create-admin.js` from `backend`. Driver registration requires the real vehicle passenger capacity; the operating policy caps which registered vehicles can be dispatched.

## Local Test Accounts and Service Data

Use a separate local/test database for walkthroughs. Do not seed approximate pilot geography or test accounts into production. The application has no separate approval step for self-registered drivers, so only use test driver registrations in a controlled development database.

1. Create the database, enable PostGIS, and apply `databases/schema.sql` followed by migrations `001` through `007` in order. If the database already has these tables and migrations applied, do not replay the base schema; continue with the remaining setup steps.
2. Configure `backend/.env` with the database credentials, a private `JWT_SECRET`, and the geography settings shown in `backend/.env.example`. `OTP_DELIVERY_MODE=development` enables local passenger OTP retrieval in the app. Never use development OTP retrieval in production.
3. If this is a fresh local database, inspect the geography values first, then from `backend` run `npm run seed:thirumangalam`. This provisions the configured Thirumangalam station, two configured service zones, and ten approximate verified road-reference pickup points. The script is designed to be rerun safely, but the coordinates are pilot/test references and must be reviewed before operational use. Skip this step when the database already has suitable station, zone, and verified point records. `databases/seed.sql` itself is intentionally empty.
4. Create an admin from a PowerShell terminal in `backend`. Replace the sample values with local test credentials; the password must be at least eight characters:

   ```powershell
   $env:ADMIN_NAME = "CMRL Local Admin"
   $env:ADMIN_EMAIL = "admin@example.test"
   $env:ADMIN_PASSWORD = "choose-a-local-password"
   node src/scripts/create-admin.js
   Remove-Item Env:ADMIN_NAME,Env:ADMIN_EMAIL,Env:ADMIN_PASSWORD
   ```

   The script does not reset an existing admin with the same email. Keep the password private and do not commit it.
5. Start the backend and frontend as described in [Start](#start). At `http://localhost:5173`, use **Register** to create a Passenger account and a Driver account with distinct emails and phone numbers. For a driver, enter the actual test vehicle registration and passenger capacity. These are ordinary database records and remain until you remove them from the local database.
6. Keep the admin, passenger, and driver sessions in separate browser profiles (or log out before switching accounts). The app stores the current session in browser local storage. Browser geolocation is available on `localhost`; allow location access when prompted.

## End-to-end Walkthrough

This exercises fare preview, booking, dispatch, boarding, and trip completion. A fare is only quoted and recorded; there is no payment collection or payment confirmation in this project.

1. **Check the service area as admin.** Sign in with the admin account. Confirm that the dashboard map shows a station, active service zones, and verified pickup points. Review the fare and operating policies. The dashboard currently monitors operations and edits policies; service geography is configured through the database/seed process.
2. **Put a test driver online.** Sign in as Driver. Choose a service mode matching the passenger journey: **Residential to Metro** for a residential pickup, or **Metro to Residential** for a station pickup. Click **Get location and go online** and allow a fresh, precise GPS fix. The driver must have a suitable active vehicle; requested seats cannot exceed the configured vehicle capacity or operating-policy cap.
3. **Create the passenger request.** Sign in as Passenger, select a journey direction, and allow location access or choose the manual-location option. Select a configured station, zone, pickup point, and seat count. Choose **Booking** to save a recurring daily schedule and choose its local departure time. The first departure is today only when that time is still ahead; otherwise it starts tomorrow. No trip is made when the schedule is saved. The worker creates the trip when each departure is due. Review the schedule and its daily occurrence state in the passenger page; canceling stops future departures and keeps prior history. Choose **Direct Booking** for one immediate trip. Click **Calculate fare**, review the estimate and breakdown, then confirm. Both paths require an eligible online driver with a matching direction, fresh accurate location, and enough vehicle capacity. The admin dashboard shows active bookings and trip states.
4. **Wait for assignment and inspect the route.** Refreshes happen automatically. Once assigned, the driver sees the trip, passenger manifest, route stops, and navigation links. For Residential to Metro, the route visits the verified service points in the zone in geographic order and then the station. For Metro to Residential, it starts at the station and visits the assigned passenger destination point(s).
5. **Confirm pickup arrival and board.** The driver must be physically near the assigned pickup (within the configured arrival radius, 200 m by default) and have a fresh, accurate location. Click **Confirm arrival** at the passenger's pickup. The passenger can then click **Show boarding OTP**; in local development the OTP appears in the passenger app. Enter it in the driver's manifest and choose **Verify boarding**. The driver can start the trip after a passenger has boarded at the first stop. The boarding timer can mark an unboarded passenger as a no-show when it expires.
6. **Complete the route.** At each stop, confirm arrival and complete it in sequence. For Residential to Metro service points with no scheduled passenger, check **No scheduled passenger at this stop** before continuing. At assigned passenger destinations, complete the stop after drop-off. Complete the final station/destination stop to finish the trip. The passenger and admin views should then show the resolved booking and completed trip.
7. **Check the result.** Review the passenger booking status, driver trip status, and admin operations/events. The fare remains a quote/booking record; do not treat it as paid. Repeat in the opposite direction to walk through the other route shape.

For the full shared-queue dispatch case, use **Booking** rather than **Direct Booking** and keep a matching driver online through the dispatch window. For quicker local iteration, **Direct Booking** attempts an immediate assignment and returns an unavailable message without creating a booking when no eligible driver is online.

## Start

Run `npm run dev` in `backend` and `npm run dev` in `frontend`. The frontend API base defaults to `http://localhost:5000/api`; `VITE_API_URL` can override it. The map uses actual station, zone, and service-point geometries and OpenStreetMap tiles; it does not fabricate live passenger or driver positions.

## DRT API

All endpoints use bearer JWT authentication. Passenger routes require a passenger identity, driver routes require a driver identity, and dashboard/policy routes require an admin identity.

- `GET /api/bookings/service-areas`
- `POST /api/bookings/location-resolution` (direction plus numeric latitude/longitude)
- `POST /api/bookings/fare-preview`
- `POST /api/bookings` (optional `Idempotency-Key` header)
- `GET|POST /api/bookings/schedules`, `POST /api/bookings/schedules/:id/cancel`
- `GET /api/bookings`, `GET /api/bookings/:id`, `POST /api/bookings/:id/cancel`, `GET /api/bookings/:id/otp`
- `GET|POST /api/drivers/availability`, `POST /api/drivers/telemetry`, `GET /api/drivers/trips`
- `POST /api/drivers/trips/:tripId/stops/:stopId/arrival|complete`, `POST /api/drivers/trips/:tripId/start`, `POST /api/drivers/bookings/:bookingId/verify-otp`
- `GET /api/dashboard/operations`, `GET /api/dashboard/policies`, `PATCH /api/dashboard/policies/fare`, `PATCH /api/dashboard/policies/operating`

Seat capacity is reserved transactionally by counting bookings in REQUESTED, ASSIGNED, BOARDING, and IN_PROGRESS states under a per-compatibility advisory lock. Cancellations and no-shows leave those seat-counting states. A persistent database-backed worker handles dispatch deadlines, bounded dispatch retries, OTP expiry, and boarding no-shows. Driver selection uses online status, location freshness, capacity fit, lower daily assignment count, then distance to the first pickup. OTPs are stored as bcrypt hashes; the development retrieval endpoint returns an OTP only after driver arrival and is disabled by default in production.

## Checks

Run `npm test` from `backend` for fare, operating policy, dispatch rules, booking states, and route/authentication checks. Run `npx eslint .` and `npx vite build` from `frontend`. The isolated end-to-end database test creates and removes uniquely named test records; it does not use or delete existing accounts, service data, bookings, or trips. It exercises recurring schedule creation/materialization/cancellation, manual location, matching, Direct Booking, and actual driver/vehicle assignment:

```powershell
$env:DRT_WORKFLOW_INTEGRATION_TESTS='1'
node --test test/recurringBooking.integration.test.js
Remove-Item Env:DRT_WORKFLOW_INTEGRATION_TESTS
```

It requires a reachable PostgreSQL/PostGIS database with migrations `001` through `006` applied. Database credentials are loaded from `backend/.env`.

## Optional Demo Fleet

The local demo simulator creates explicitly flagged `DEMO` driver/passenger accounts, maintains fresh eligible locations for idle demo drivers, and leaves all trip assignment to the normal dispatch worker. It can move and complete synthetic ghost-passenger trips through the normal route, boarding OTP, and stop-completion rules. It only advances trips made entirely from synthetic ghost bookings; bookings created manually by demo account users still require the normal passenger and driver actions. Keep it disabled outside a local demonstration; it refuses to start with `NODE_ENV=production`.

Apply migration `007_demo_accounts.sql`, then set these values in `backend/.env` (do not commit the file):

```dotenv
DEMO_SIMULATION_ENABLED=true
DEMO_M2R_AVAILABLE_TARGET=6
DEMO_R2M_AVAILABLE_TARGET=6
DEMO_DRIVER_POOL_SIZE_PER_DIRECTION=12
DEMO_PASSENGER_POOL_SIZE=12
DEMO_DRIVER_MOVEMENT_ENABLED=true
DEMO_DRIVER_LOCATION_UPDATE_INTERVAL_MS=5000
DEMO_GHOST_PASSENGERS_ENABLED=false
DEMO_GHOST_PASSENGER_INTERVAL_SECONDS=60
DEMO_MAX_ACTIVE_GHOST_BOOKINGS=12
DEMO_AUTO_COMPLETE_TRIPS=true
DEMO_ACCOUNT_PASSWORD=63f5aa28b118349f39f2ca9461cebd8f
```

The demo pool is twelve drivers per direction (24 total) and twelve passengers; the active synthetic-booking cap is twelve. Driver and passenger pool sizes are configurable from 1 to 50. The target is the number of normally eligible drivers desired in each direction. Seed legitimate station, active zones, verified service points, and operating policies first. Then, from `backend`, run:

```powershell
npm run demo:seed
npm run demo:inspect
npm run dev
```

Demo driver emails are `cmrl.demo.m2r.01@example.test` through `.12@example.test` and `cmrl.demo.r2m.01@example.test` through `.12@example.test`. Demo passenger emails are `cmrl.demo.passenger.01@example.test` onward. Re-run `npm run demo:seed` after changing pool sizes; it adds or refreshes configured demo accounts, preserves drivers with active trips, and never removes bookings or history. Ghost passenger selection rotates among accounts with the fewest previous synthetic bookings. Sign in with the local `DEMO_ACCOUNT_PASSWORD`; the seed and inspect commands never print passwords. The accounts are explicitly labeled DEMO and can be logged into through the existing Driver/Passenger forms. Existing configured coordinates are used: M2R drivers start at the configured station and R2M drivers rotate among verified road pickup points. With movement disabled, each keeps a fixed legitimate coordinate while its timestamp refreshes. Drivers on active trips are never moved or made available by the simulator.

Ghost passenger requests are disabled by default. To enable them for a controlled local demonstration, set `DEMO_GHOST_PASSENGERS_ENABLED=true` and restart the backend. The service uses flagged demo passenger accounts, the existing fare preview and booking service, valid configured geography, unique idempotency keys, the normal shared queue, and the configured active-booking cap. With `DEMO_AUTO_COMPLETE_TRIPS=true` and `DEMO_DRIVER_MOVEMENT_ENABLED=true`, the simulator moves synthetic trips one stop per location-update interval, boards synthetic passengers using an internal OTP, completes each stop in order, and refreshes the CSV when a trip finishes. Set auto-completion to `false` to leave route actions manual. Set ghost passenger creation back to `false` and restart to stop new demand; existing synthetic trips continue to completion when auto-completion remains enabled. The admin dashboard shows DEMO pool counts, target shortfalls, last location update, errors, vehicles, active synthetic bookings, and whether automatic synthetic trip completion is enabled; demo map markers are labeled DEMO.

Demo booking history is stored in PostgreSQL. The backend refreshes `backend/exports/demo-trip-history.csv` when it creates a synthetic booking and after a driver completes a stop on a trip with demo passengers. The CSV includes demo booking source/status, fare and fare breakdown, requested/dispatch/arrival/boarding/completion timestamps, cab duration (boarding to passenger completion), and full trip duration (dispatch to trip completion). It excludes non-demo passenger accounts, OTPs, and passwords. To create or refresh the CSV at any time, run `npm run demo:export` from `backend`. The file is ignored by Git and can be opened in Excel.

### Admin Data Analytics

The admin dashboard has a **Data Analaytics** button at its bottom, opening `/admin/analytics`. Analytics reads the local `backend/exports/demo-trip-history.csv`; set `DEMO_TRIP_HISTORY_CSV` in `backend/.env` only when using another server-side CSV path. If the default file is missing, the service checks the local `export/demo-trip-history.csv` and `backend/export/demo-trip-history.csv` alternatives. It never accepts a filesystem path from a browser request. Generate current data with `npm run demo:export` from `backend`.

The page fits separate Multiple Linear Regression models: fare uses distance, request time, the operating-policy peak flag, direction, and a distance/peak interaction; duration uses distance and boarding time with the same policy and direction features. Time of day is encoded cyclically. Fare training prefers a valid `final_fare`, then uses `fare_amount`. Duration training only uses completed passenger bookings and measures `boarded_at_utc` through `booking_completed_at_utc`; it does not use full trip duration or dispatch waiting time. Neither model changes live fare calculation or dispatch.

The models use a deterministic 80/20 holdout grouped by trip, and report actual held-out MAE and RMSE. R² appears only when meaningful. A model needs at least 20 usable rows across 8 distinct trips and a full-rank feature matrix; otherwise the page reports insufficient data or rank deficiency without metrics or predictions. The cache fingerprint includes the CSV content and active operating peak policy, so changes cause retraining while unchanged requests reuse the fitted models.

Private-vehicle inputs (petrol price, fuel efficiency, parking, road-distance adjustment, and rush/off-peak travel-time benchmarks) are entered by the admin and saved in that browser's local storage. They are personal comparison assumptions, not verified averages. Estimated car cost includes fuel and parking only. Since the demo CSV distance is a straight-line estimate, use an actual road distance or adjust it with the entered multiplier. The page compares the predicted fare/time with those inputs and may show either option as cheaper or faster. Small demo samples, incomplete trips, or straight-line distances can make estimates weak; results are not guaranteed outcomes.

To reset availability without deleting demo accounts or history, stop the backend, set `DEMO_SIMULATION_ENABLED=false`, then run `npm run demo:reset` from `backend`. The command preserves drivers assigned to active trips, all vehicles, bookings, and history. The simulator does not delete data.

To run the read-only PostgreSQL/PostGIS integration test in PowerShell from `backend`, use `$env:DRT_INTEGRATION_TESTS='1'; node --test test/database.integration.test.js; Remove-Item Env:DRT_INTEGRATION_TESTS`. Database credentials are loaded from `backend/.env`.

change

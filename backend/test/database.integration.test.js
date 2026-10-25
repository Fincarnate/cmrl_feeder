const test = require("node:test");
const assert = require("node:assert/strict");

const enabled = process.env.DRT_INTEGRATION_TESTS === "1";
test("PostgreSQL/PostGIS DRT schema and authenticated API integration", { skip: !enabled }, async t => {
    process.env.JWT_SECRET ||= "cmrl-feeder-integration-test-only-secret";
    const pool = require("../src/db/pool");
    const buildApp = require("../src/app");
    const { generateToken } = require("../src/utils/jwt");
    const policyQueries = require("../src/modules/drt/queries/policyQueries");
    const bookingQueries = require("../src/modules/drt/queries/bookingQueries");
    const dashboardQueries = require("../src/db/queries/dashboardQueries");
    const app = buildApp();
    t.after(async () => { await app.close(); await pool.end(); });
    await app.ready();

    const { rows } = await pool.query(`SELECT current_database() AS database,
      PostGIS_Full_Version() AS postgis,
      to_regclass('public.drt_fare_policy') AS fare_policy,
      to_regclass('public.drt_operating_policy') AS operating_policy,
      to_regclass('public.drt_engine_event') AS engine_events`);
    assert.equal(rows[0].database, process.env.DB_NAME);
    assert.match(rows[0].postgis, /POSTGIS=/i);
    assert.ok(rows[0].fare_policy && rows[0].operating_policy && rows[0].engine_events);
    const journeyColumns = await pool.query(`SELECT COUNT(*)::int AS count FROM information_schema.columns
      WHERE table_schema='public' AND table_name='booking' AND column_name IN ('booking_intent','origin_location','origin_location_source','gps_verified_at','pickup_acknowledged')`);
    assert.equal(journeyColumns.rows[0].count, 5);

    const policies = await policyQueries.listPolicies();
    assert.equal(Number(policies.fare.version) > 0, true);
    assert.equal(Number(policies.operating.version) > 0, true);
    assert.equal(policies.operating.timezone, "Asia/Kolkata");

    const areas = await bookingQueries.getServiceAreas();
    assert.ok(Array.isArray(areas));
    const summary = await dashboardQueries.getDashboardSummary();
    assert.equal(typeof summary.totalPassengers, "number");
    const map = await dashboardQueries.getDashboardMapData();
    assert.ok(Array.isArray(map.stations) && Array.isArray(map.zones) && Array.isArray(map.servicePoints));
    const operations = await dashboardQueries.getDashboardOperations();
    assert.ok(Array.isArray(operations.activeTrips) && Array.isArray(operations.resolvedBookings));

    const token = generateToken({ id: "33333333-3333-4333-8333-333333333333", email: "admin@example.invalid", role: "ADMIN" });
    const auth = { authorization: `Bearer ${token}` };
    const policyResponse = await app.inject({ method: "GET", url: "/api/dashboard/policies", headers: auth });
    assert.equal(policyResponse.statusCode, 200);
    const areaResponse = await app.inject({ method: "GET", url: "/api/bookings/service-areas", headers: { authorization: `Bearer ${generateToken({ id: "44444444-4444-4444-8444-444444444444", email: "passenger@example.invalid", role: "PASSENGER" })}` } });
    assert.equal(areaResponse.statusCode, 200);
    const passengerAuth = { authorization: `Bearer ${generateToken({ id: "44444444-4444-4444-8444-444444444444", email: "passenger@example.invalid", role: "PASSENGER" })}` };
    const invalidLocation = await app.inject({ method: "POST", url: "/api/bookings/location-resolution", headers: passengerAuth, payload: { direction: "RESIDENTIAL_TO_METRO", latitude: 91, longitude: 80 } });
    assert.equal(invalidLocation.statusCode, 400);
    const locationCheck = await app.inject({ method: "POST", url: "/api/bookings/location-resolution", headers: passengerAuth, payload: { direction: "METRO_TO_RESIDENTIAL", latitude: 13.08, longitude: 80.27 } });
    assert.equal(locationCheck.statusCode, 200);
    assert.ok(["AT_SUPPORTED_STATION", "OUTSIDE_STATION"].includes(locationCheck.json().result));
    const unsupported = await app.inject({
        method: "POST", url: "/api/bookings/fare-preview",
        headers: { authorization: `Bearer ${generateToken({ id: "44444444-4444-4444-8444-444444444444", email: "passenger@example.invalid", role: "PASSENGER" })}` },
        payload: { direction: "RESIDENTIAL_TO_METRO", stationId: "55555555-5555-4555-8555-555555555555", zoneId: "66666666-6666-4666-8666-666666666666", servicePointId: "77777777-7777-4777-8777-777777777777", seatsRequested: 1 }
    });
    assert.equal(unsupported.statusCode, 422);
});

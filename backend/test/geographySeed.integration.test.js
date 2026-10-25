const test = require("node:test");
const assert = require("node:assert/strict");

const enabled = process.env.DRT_INTEGRATION_TESTS === "1";
test("Thirumangalam geographic seed is valid, repeatable, and updates managed radii", { skip: !enabled }, async t => {
    const pool = require("../src/db/pool");
    const { loadGeographyConfig } = require("../src/config/env");
    const { seedThirumangalam } = require("../src/scripts/seed-thirumangalam");
    t.after(async () => pool.end());
    const config = loadGeographyConfig();
    const first = await seedThirumangalam(pool, config);
    const second = await seedThirumangalam(pool, config);
    assert.equal(second.station.id, first.station.id);
    assert.deepEqual(second.zones.map(zone => zone.id), first.zones.map(zone => zone.id));
    assert.equal(first.station.serviceRadiusKm, 16);
    assert.equal(first.station.geofenceRadiusMeters, 300);
    assert.ok(first.zones.every(zone => zone.radiusKm === 3));
    assert.equal(first.station.geofenceSource, "CONFIGURED_APPROXIMATE_GEOFENCE");
    assert.equal(first.zonesOverlap, true);
    assert.ok(second.referencePoints.every(point => point.status === "UNVERIFIED" || point.status === "VERIFIED"));

    const actualCounts = await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM metro_station WHERE lower(btrim(station_name))='thirumangalam metro station') AS stations,
      (SELECT COUNT(*)::int FROM service_zone WHERE station_id=$1 AND lower(zone_name) IN ('collector nagar','golden flats')) AS zones`, [first.station.id]);
    assert.equal(actualCounts.rows[0].stations, 1);
    assert.equal(actualCounts.rows[0].zones, 2);

    const narrower = { ...config, metroServiceRadiusKm: 15 };
    try {
        const changed = await seedThirumangalam(pool, narrower);
        assert.equal(changed.station.serviceRadiusKm, 15);
        assert.ok(Math.abs(changed.station.measuredCatchmentRadiusMeters - 15000) <= 10);
    } finally {
        const restored = await seedThirumangalam(pool, config);
        assert.equal(restored.station.serviceRadiusKm, 16);
    }
});

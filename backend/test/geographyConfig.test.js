const test = require("node:test");
const assert = require("node:assert/strict");
const { loadGeographyConfig } = require("../src/config/env");

const valid = {
    DRT_METRO_SERVICE_RADIUS_KM: "16",
    DRT_STATION_GEOFENCE_RADIUS_M: "300",
    DRT_SERVICE_ZONE_RADIUS_KM: "3",
    THIRUMANGALAM_STATION_LAT: "13.08528",
    THIRUMANGALAM_STATION_LON: "80.20152",
    COLLECTOR_NAGAR_CENTER_LAT: "13.08849",
    COLLECTOR_NAGAR_CENTER_LON: "80.19097",
    GOLDEN_FLATS_CENTER_LAT: "13.0883",
    GOLDEN_FLATS_CENTER_LON: "80.17841"
};

test("geographic configuration parses centers and radii as numeric values", () => {
    const geography = loadGeographyConfig(valid);
    assert.equal(geography.station.latitude, 13.08528);
    assert.equal(geography.station.longitude, 80.20152);
    assert.equal(geography.metroServiceRadiusKm, 16);
    assert.equal(geography.stationGeofenceRadiusM, 300);
    assert.equal(geography.serviceZoneRadiusKm, 3);
    assert.deepEqual(geography.zones.map(zone => [zone.name, zone.latitude, zone.longitude]), [
        ["Collector Nagar", 13.08849, 80.19097], ["Golden Flats", 13.0883, 80.17841]
    ]);
});

test("missing Golden Flats coordinates fail before the seed can connect", () => {
    const invalid = { ...valid, GOLDEN_FLATS_CENTER_LAT: "", GOLDEN_FLATS_CENTER_LON: "" };
    assert.throws(() => loadGeographyConfig(invalid), /GOLDEN_FLATS_CENTER_LAT is required/);
});

test("invalid coordinates and non-positive radii are rejected", () => {
    assert.throws(() => loadGeographyConfig({ ...valid, THIRUMANGALAM_STATION_LAT: "91" }), /between -90 and 90/);
    assert.throws(() => loadGeographyConfig({ ...valid, DRT_SERVICE_ZONE_RADIUS_KM: "0" }), /positive number/);
    assert.throws(() => loadGeographyConfig({ ...valid, COLLECTOR_NAGAR_CENTER_LON: "not-a-number" }), /finite number/);
});

const pool = require("../db/pool");
const { loadGeographyConfig } = require("../config/env");

const normalizeSql = "lower(regexp_replace(btrim(%s), '\\s+', ' ', 'g'))";

const roadPointConfig = {
    "Collector Nagar": [
        { name: "Collector Nagar - Park Road reference stop 1", latitude: 13.0930, longitude: 80.1923 },
        { name: "Collector Nagar - 2nd Avenue reference stop 2", latitude: 13.0901, longitude: 80.1954 },
        { name: "Collector Nagar - 3rd Main Road reference stop 3", latitude: 13.0848, longitude: 80.1959 },
        { name: "Collector Nagar - Veeramamunivar Road reference stop 4", latitude: 13.0856, longitude: 80.1864 },
        { name: "Collector Nagar - Thirumangalam Mogappair Road reference stop 5", latitude: 13.0879, longitude: 80.1842 }
    ],
    "Golden Flats": [
        { name: "Golden Flats - Ambattur Estate Road reference stop 1", latitude: 13.0883, longitude: 80.1740 },
        { name: "Golden Flats - Chennai Tiruttani Road reference stop 2", latitude: 13.0940, longitude: 80.1805 },
        { name: "Golden Flats - Ambit Park Road reference stop 3", latitude: 13.0917, longitude: 80.1735 },
        { name: "Golden Flats - Panneer Nagar Main Road reference stop 4", latitude: 13.0840, longitude: 80.1783 },
        { name: "Golden Flats - Veeramamunivar Road reference stop 5", latitude: 13.0830, longitude: 80.1820 }
    ]
};

async function findUniqueByName(client, table, column, name, stationId = null) {
    const expression = normalizeSql.replace("%s", `t.${column}`);
    const values = stationId ? [name, stationId] : [name];
    const parentColumn = table === "service_point" ? "zone_id" : "station_id";
    const stationClause = stationId ? `AND t.${parentColumn}=$2` : "";
    const { rows } = await client.query(`SELECT t.* FROM ${table} t WHERE ${expression}=lower(regexp_replace(btrim($1), '\\s+', ' ', 'g')) ${stationClause} ORDER BY t.${column === "station_name" ? "station_id" : column === "zone_name" ? "zone_id" : "point_id"} FOR UPDATE`, values);
    if (rows.length > 1) throw new Error(`Multiple ${table} records match normalized name "${name}"; resolve the duplicate before seeding.`);
    return rows[0] || null;
}

async function getStation(client, geography) {
    let station = await findUniqueByName(client, "metro_station", "station_name", geography.station.name);
    if (!station) {
        const result = await client.query(`INSERT INTO metro_station(station_name,station_coords,is_active,station_center_source)
          VALUES($1,ST_SetSRID(ST_MakePoint($2,$3),4326),TRUE,'CONFIGURED_OPENSTREETMAP_MAPCARTA_REFERENCE') RETURNING *`,
        [geography.station.name, geography.station.longitude, geography.station.latitude]);
        station = result.rows[0];
    }
    const result = await client.query(`UPDATE metro_station SET
      station_coords=CASE WHEN station_coords IS NULL OR station_center_source LIKE 'CONFIGURED_REFERENCE:%' OR station_center_source='CONFIGURED_OPENSTREETMAP_MAPCARTA_REFERENCE' THEN
        ST_SetSRID(ST_MakePoint($2,$3),4326) ELSE station_coords END,
      station_center_source=CASE WHEN station_coords IS NULL OR station_center_source LIKE 'CONFIGURED_REFERENCE:%' OR station_center_source='CONFIGURED_OPENSTREETMAP_MAPCARTA_REFERENCE' THEN $4
        ELSE COALESCE(station_center_source,'EXISTING_UNCLASSIFIED') END,
      service_area_polygon=CASE WHEN service_area_polygon IS NULL OR service_area_source='CONFIGURED_GEOGRAPHY_BUFFER' THEN
        ST_Buffer((CASE WHEN station_coords IS NULL OR station_center_source LIKE 'CONFIGURED_REFERENCE:%' OR station_center_source='CONFIGURED_OPENSTREETMAP_MAPCARTA_REFERENCE' THEN ST_SetSRID(ST_MakePoint($2,$3),4326) ELSE station_coords END)::geography,$5::double precision*1000)::geometry(Polygon,4326)
        ELSE service_area_polygon END,
      service_area_source=CASE WHEN service_area_polygon IS NULL OR service_area_source='CONFIGURED_GEOGRAPHY_BUFFER' THEN 'CONFIGURED_GEOGRAPHY_BUFFER'
        ELSE COALESCE(service_area_source,'EXISTING_UNCLASSIFIED') END,
      service_radius_km=CASE WHEN service_area_polygon IS NULL OR service_area_source='CONFIGURED_GEOGRAPHY_BUFFER' THEN $6 ELSE service_radius_km END,
      service_boundary_polygon=CASE WHEN service_boundary_polygon IS NULL OR station_geofence_source='CONFIGURED_APPROXIMATE_GEOFENCE' THEN
        ST_Buffer((CASE WHEN station_coords IS NULL OR station_center_source LIKE 'CONFIGURED_REFERENCE:%' OR station_center_source='CONFIGURED_OPENSTREETMAP_MAPCARTA_REFERENCE' THEN ST_SetSRID(ST_MakePoint($2,$3),4326) ELSE station_coords END)::geography,$7::double precision)::geometry(Polygon,4326)
        ELSE service_boundary_polygon END,
      station_geofence_source=CASE WHEN service_boundary_polygon IS NULL OR station_geofence_source='CONFIGURED_APPROXIMATE_GEOFENCE' THEN 'CONFIGURED_APPROXIMATE_GEOFENCE'
        ELSE COALESCE(station_geofence_source,'EXISTING_UNCLASSIFIED') END,
      station_geofence_radius_m=CASE WHEN service_boundary_polygon IS NULL OR station_geofence_source='CONFIGURED_APPROXIMATE_GEOFENCE' THEN $8 ELSE station_geofence_radius_m END,
      is_active=TRUE,geometry_updated_at=clock_timestamp()
      WHERE station_id=$1 RETURNING *`, [station.station_id, geography.station.longitude, geography.station.latitude,
        "CONFIGURED_OPENSTREETMAP_MAPCARTA_REFERENCE", geography.metroServiceRadiusKm, geography.metroServiceRadiusKm,
        geography.stationGeofenceRadiusM, geography.stationGeofenceRadiusM]);
    return result.rows[0];
}

async function getZone(client, station, zoneConfig, radiusKm) {
    let zone = await findUniqueByName(client, "service_zone", "zone_name", zoneConfig.name, station.station_id);
    const centerSource = `CONFIGURED_REFERENCE:${zoneConfig.coordinateSource}`;
    if (!zone) {
        const inserted = await client.query(`INSERT INTO service_zone(station_id,zone_name,zone_type,is_active,
          center_coords,center_source,service_radius_km,boundary_polygon,boundary_source)
          VALUES($1,$2,'RESIDENTIAL',TRUE,ST_SetSRID(ST_MakePoint($3,$4),4326),$5,$7,
            ST_Buffer(ST_SetSRID(ST_MakePoint($3,$4),4326)::geography,$6::double precision*1000)::geometry(Polygon,4326),'CONFIGURED_GEOGRAPHY_BUFFER') RETURNING *`,
        [station.station_id, zoneConfig.name, zoneConfig.longitude, zoneConfig.latitude, centerSource, radiusKm, radiusKm]);
        zone = inserted.rows[0];
    } else {
        const updated = await client.query(`UPDATE service_zone SET
          center_coords=CASE WHEN center_coords IS NULL OR center_source LIKE 'CONFIGURED_REFERENCE:%' THEN ST_SetSRID(ST_MakePoint($2,$3),4326) ELSE center_coords END,
          center_source=CASE WHEN center_coords IS NULL OR center_source LIKE 'CONFIGURED_REFERENCE:%' THEN $4 ELSE COALESCE(center_source,'EXISTING_UNCLASSIFIED') END,
          boundary_polygon=CASE WHEN boundary_polygon IS NULL OR boundary_source='CONFIGURED_GEOGRAPHY_BUFFER' THEN
            ST_Buffer((CASE WHEN center_coords IS NULL OR center_source LIKE 'CONFIGURED_REFERENCE:%' THEN ST_SetSRID(ST_MakePoint($2,$3),4326) ELSE center_coords END)::geography,$5::double precision*1000)::geometry(Polygon,4326)
            ELSE boundary_polygon END,
          boundary_source=CASE WHEN boundary_polygon IS NULL OR boundary_source='CONFIGURED_GEOGRAPHY_BUFFER' THEN 'CONFIGURED_GEOGRAPHY_BUFFER'
            ELSE COALESCE(boundary_source,'EXISTING_UNCLASSIFIED') END,
          service_radius_km=CASE WHEN boundary_polygon IS NULL OR boundary_source='CONFIGURED_GEOGRAPHY_BUFFER' THEN $6 ELSE service_radius_km END,
          zone_type=COALESCE(zone_type,'RESIDENTIAL'),is_active=TRUE,geometry_updated_at=clock_timestamp()
          WHERE zone_id=$1 RETURNING *`, [zone.zone_id, zoneConfig.longitude, zoneConfig.latitude,
            centerSource, radiusKm, radiusKm]);
        zone = updated.rows[0];
    }
    return zone;
}

async function ensureReferencePoint(client, zone, zoneConfig) {
    const pointName = `${zoneConfig.name} reference center (unverified)`;
    let point = await findUniqueByName(client, "service_point", "point_name", pointName, zone.zone_id);
    if (!point) {
        const inserted = await client.query(`INSERT INTO service_point(zone_id,point_name,location_coords,road_access_status,
          is_hub_stop,is_active,verification_status,coordinate_source)
          VALUES($1,$2,(SELECT center_coords FROM service_zone WHERE zone_id=$1),'UNVERIFIED',FALSE,FALSE,'UNVERIFIED',$3) RETURNING point_id`,
        [zone.zone_id, pointName, `CONFIGURED_UNVERIFIED_REFERENCE:${zoneConfig.coordinateSource}`]);
        return { id: inserted.rows[0].point_id, name: pointName, status: "UNVERIFIED", active: false, created: true };
    }
    if (String(point.coordinate_source || "").startsWith("CONFIGURED_UNVERIFIED_REFERENCE:") && point.verification_status !== "VERIFIED") {
        await client.query(`UPDATE service_point SET location_coords=(SELECT center_coords FROM service_zone WHERE zone_id=$2),
          is_active=FALSE,verification_status='UNVERIFIED',road_access_status='UNVERIFIED' WHERE point_id=$1`, [point.point_id, zone.zone_id]);
    }
    return { id: point.point_id, name: point.point_name, status: point.verification_status, active: point.is_active, created: false };
}

async function ensureRoadPoints(client, zone) {
    const definitions = roadPointConfig[zone.zone_name];
    if (!definitions || definitions.length !== 5) throw new Error(`Expected exactly five configured road reference points for ${zone.zone_name}.`);
    const points = [];
    for (const definition of definitions) {
        let point = await findUniqueByName(client, "service_point", "point_name", definition.name, zone.zone_id);
        if (!point) {
            const inserted = await client.query(`INSERT INTO service_point(zone_id,point_name,location_coords,road_access_status,
              is_hub_stop,is_active,verification_status,coordinate_source)
              VALUES($1,$2,ST_SetSRID(ST_MakePoint($3,$4),4326),'APPROXIMATE',FALSE,TRUE,'VERIFIED','USER_REQUESTED_ARBITRARY_ROAD_REFERENCE') RETURNING *`,
            [zone.zone_id, definition.name, definition.longitude, definition.latitude]);
            point = inserted.rows[0];
        } else if (point.coordinate_source === "ARBITRARY_UNVERIFIED_ROAD_REFERENCE" || point.coordinate_source === "USER_REQUESTED_ARBITRARY_ROAD_REFERENCE") {
            const updated = await client.query(`UPDATE service_point SET location_coords=ST_SetSRID(ST_MakePoint($2,$3),4326),
              is_active=TRUE,verification_status='VERIFIED',road_access_status='APPROXIMATE',
              coordinate_source='USER_REQUESTED_ARBITRARY_ROAD_REFERENCE'
              WHERE point_id=$1 RETURNING *`, [point.point_id, definition.longitude, definition.latitude]);
            point = updated.rows[0];
        }
        points.push(point);
    }
    return points;
}

async function validateRoadPoints(client, zones, roadPoints) {
    if (roadPoints.length !== 10) throw new Error("Expected ten road reference service points across the two configured zones.");
    const pointIds = roadPoints.map(point => point.point_id);
    const inside = await client.query(`SELECT COUNT(*)::int AS count FROM service_point sp
      JOIN service_zone sz ON sz.zone_id=sp.zone_id
      WHERE sp.point_id=ANY($1::uuid[]) AND sp.location_coords IS NOT NULL
        AND ST_IsValid(sz.boundary_polygon) AND ST_Covers(sz.boundary_polygon,sp.location_coords)`, [pointIds]);
    if (inside.rows[0].count !== 10) throw new Error("Every configured road reference point must be inside its service-zone boundary.");
    if (roadPoints.some(point => point.verification_status !== "VERIFIED" || !point.is_active)) throw new Error("Every configured road reference point must be active and verified.");
    const spacing = await client.query(`SELECT MIN(ST_Distance(a.location_coords::geography,b.location_coords::geography)) AS min_m
      FROM service_point a JOIN service_point b ON a.point_id<b.point_id
      WHERE a.point_id=ANY($1::uuid[]) AND b.point_id=ANY($1::uuid[])`, [pointIds]);
    const minDistanceMeters = Number(spacing.rows[0].min_m);
    if (minDistanceMeters < 300) throw new Error(`Configured road reference points are too close together (${Math.round(minDistanceMeters)} m minimum; require at least 300 m).`);
    return { count: roadPoints.length, minimumSeparationMeters: Math.round(minDistanceMeters), allInsideZones: true };
}

async function validateGeometries(client, station, zones, geography) {
    const stationCheck = await client.query(`SELECT ST_AsGeoJSON(station_coords)::json AS station_center,ST_SRID(station_coords)=4326 AS station_srid,
      ST_IsValid(service_area_polygon) AS catchment_valid,ST_SRID(service_area_polygon)=4326 AS catchment_srid,
      ST_IsValid(service_boundary_polygon) AS geofence_valid,ST_SRID(service_boundary_polygon)=4326 AS geofence_srid,
      ST_Distance(station_coords::geography,ST_PointN(ST_ExteriorRing(service_area_polygon),1)::geography) AS catchment_radius_m,
      ST_Distance(station_coords::geography,ST_PointN(ST_ExteriorRing(service_boundary_polygon),1)::geography) AS geofence_radius_m
      FROM metro_station WHERE station_id=$1`, [station.station_id]);
    const s = stationCheck.rows[0];
    if (!s.station_srid || !s.catchment_valid || !s.catchment_srid || !s.geofence_valid || !s.geofence_srid) throw new Error("Station coordinates or generated station polygons are invalid or do not use SRID 4326.");
    if (station.service_area_source === "CONFIGURED_GEOGRAPHY_BUFFER" && Math.abs(Number(s.catchment_radius_m) - geography.metroServiceRadiusKm * 1000) > 10) throw new Error("Generated station service catchment did not match the configured radius.");
    if (station.station_geofence_source === "CONFIGURED_APPROXIMATE_GEOFENCE" && Math.abs(Number(s.geofence_radius_m) - geography.stationGeofenceRadiusM) > 5) throw new Error("Generated station geofence did not match the configured radius.");
    const reports = [];
    for (const zone of zones) {
        const check = await client.query(`SELECT ST_IsValid(boundary_polygon) AS valid,ST_SRID(boundary_polygon)=4326 AS srid_ok,
          ST_AsGeoJSON(center_coords)::json AS center,ST_SRID(center_coords)=4326 AS center_srid,ST_Covers($2,center_coords) AS in_catchment,
          ST_Distance(center_coords::geography,ST_PointN(ST_ExteriorRing(boundary_polygon),1)::geography) AS radius_m
          FROM service_zone WHERE zone_id=$1`, [zone.zone_id, station.service_area_polygon]);
        const z = check.rows[0];
        if (!z.valid || !z.srid_ok || !z.center_srid || !z.in_catchment) throw new Error(`Zone ${zone.zone_name} has invalid geometry or its configured center is outside the station service catchment.`);
        if (zone.boundary_source === "CONFIGURED_GEOGRAPHY_BUFFER" && Math.abs(Number(z.radius_m) - geography.serviceZoneRadiusKm * 1000) > 5) throw new Error(`Generated zone ${zone.zone_name} did not match the configured radius.`);
        reports.push({ id: zone.zone_id, name: zone.zone_name, latitude: Number(z.center.coordinates[1]), longitude: Number(z.center.coordinates[0]), radiusKm: Number(zone.service_radius_km), boundarySource: zone.boundary_source, boundaryRadiusMeters: Math.round(Number(z.radius_m)) });
    }
    const overlap = await client.query(`SELECT ST_Overlaps(a.boundary_polygon,b.boundary_polygon) AS zones_overlap
      FROM service_zone a JOIN service_zone b ON a.station_id=b.station_id
      WHERE a.zone_id=$1 AND b.zone_id=$2 LIMIT 1`, [zones[0].zone_id, zones[1].zone_id]);
    return { station: { id: station.station_id, name: station.station_name,
        center: { latitude: Number(s.station_center.coordinates[1]), longitude: Number(s.station_center.coordinates[0]) },
        centerSource: station.station_center_source, serviceRadiusKm: Number(station.service_radius_km), serviceAreaSource: station.service_area_source,
        geofenceRadiusMeters: Number(station.station_geofence_radius_m), geofenceSource: station.station_geofence_source,
        measuredCatchmentRadiusMeters: Math.round(Number(s.catchment_radius_m)), measuredGeofenceRadiusMeters: Math.round(Number(s.geofence_radius_m)) },
      zones: reports, zonesOverlap: Boolean(overlap.rows[0]?.zones_overlap) };
}

async function seedThirumangalam(database = pool, geography = loadGeographyConfig()) {
    const client = await database.connect();
    try {
        const extension = await client.query("SELECT PostGIS_Full_Version() AS version");
        if (!extension.rows[0]?.version) throw new Error("PostGIS is not installed in the configured database.");
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["cmrl-feeder:seed:thirumangalam-v1"]);
        const station = await getStation(client, geography);
        const zones = [];
        const points = [];
        const roadPoints = [];
        for (const zoneConfig of geography.zones) {
            const zone = await getZone(client, station, zoneConfig, geography.serviceZoneRadiusKm);
            zones.push(zone);
            points.push(await ensureReferencePoint(client, zone, zoneConfig));
            roadPoints.push(...await ensureRoadPoints(client, zone));
        }
        if (zones.length !== 2) throw new Error("Expected both configured residential service zones.");
        const report = await validateGeometries(client, station, zones, geography);
        const roadPointValidation = await validateRoadPoints(client, zones, roadPoints);
        await client.query("COMMIT");
        return { ...report, referencePoints: points, roadPoints: roadPoints.map(point => ({ id: point.point_id, name: point.point_name, status: point.verification_status, active: point.is_active })), roadPointValidation, postgis: extension.rows[0].version.split(" ")[0] };
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

if (require.main === module) {
    let geography;
    try { geography = loadGeographyConfig(); }
    catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
    if (geography) seedThirumangalam(pool, geography)
        .then(report => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
        .catch(error => { process.stderr.write(`Geographic seed failed; no partial changes were committed. ${error.message}\n`); process.exitCode = 1; })
        .finally(() => pool.end());
}

module.exports = { seedThirumangalam };

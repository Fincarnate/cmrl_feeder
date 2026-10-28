const bcrypt = require("bcrypt");
const pool = require("../db/pool");
const config = require("../config/env");

function validateSeedConfig() {
    const { demo } = config;
    if (String(demo.nodeEnv).toLowerCase() === "production") throw new Error("Demo fleet seeding is disabled in production.");
    if (!demo.accountPassword || demo.accountPassword.length < 8 || demo.accountPassword.length > 72) {
        throw new Error("Set DEMO_ACCOUNT_PASSWORD to a private password of 8 to 72 characters before seeding demo accounts.");
    }
    if (!Number.isInteger(demo.driverPoolSizePerDirection) || demo.driverPoolSizePerDirection < 1 || demo.driverPoolSizePerDirection > 50) {
        throw new Error("DEMO_DRIVER_POOL_SIZE_PER_DIRECTION must be an integer from 1 to 50.");
    }
}

async function loadGeography(client) {
    const stationName="Thirumangalam Metro Station";
    const hasConfiguredCoordinates=process.env.THIRUMANGALAM_STATION_LAT!==undefined&&process.env.THIRUMANGALAM_STATION_LON!==undefined;
    let stationCoordinates=null;
    if(hasConfiguredCoordinates){
        const latitude=Number(process.env.THIRUMANGALAM_STATION_LAT),longitude=Number(process.env.THIRUMANGALAM_STATION_LON);
        if(!Number.isFinite(latitude)||latitude < -90||latitude>90||!Number.isFinite(longitude)||longitude < -180||longitude>180)
            throw new Error("Configured Thirumangalam station coordinates are invalid.");
        stationCoordinates={latitude,longitude};
    }
    const { rows } = await client.query(`
      SELECT ms.station_id,ms.station_coords,sz.zone_id,sz.zone_name,sp.point_id,sp.location_coords
      FROM metro_station ms
      JOIN service_zone sz ON sz.station_id=ms.station_id AND sz.is_active=TRUE
      JOIN service_point sp ON sp.zone_id=sz.zone_id AND sp.is_active=TRUE AND sp.verification_status='VERIFIED'
      WHERE ms.is_active=TRUE AND ms.station_name=$1 AND ms.station_coords IS NOT NULL
        AND ms.service_area_polygon IS NOT NULL AND sz.boundary_polygon IS NOT NULL AND sz.center_coords IS NOT NULL
        AND ST_IsValid(ms.service_area_polygon) AND ST_IsValid(sz.boundary_polygon)
        AND ST_Covers(ms.service_area_polygon,sz.center_coords) AND ST_Covers(sz.boundary_polygon,sp.location_coords)
        AND ST_IsValid(ms.service_area_polygon) AND ST_IsValid(sz.boundary_polygon)
        AND ($2::float8 IS NULL OR ST_DWithin(ms.station_coords::geography,ST_SetSRID(ST_MakePoint($3,$2),4326)::geography,1000))
      ORDER BY sz.zone_name,sp.point_name,sp.point_id`,[stationName,stationCoordinates?.latitude??null,stationCoordinates?.longitude??null]);
    if (!rows.length) throw new Error(`No valid configured ${stationName}, active zone, and verified service point were found. Run the approved service-area seed first; no geography was created.`);
    const byZone = new Map();
    for (const row of rows) {
        if (!byZone.has(row.zone_id)) byZone.set(row.zone_id,{zoneId:row.zone_id,zoneName:row.zone_name,stationId:row.station_id,station:row.station_coords,points:[]});
        byZone.get(row.zone_id).points.push(row.location_coords);
    }
    const zones=[...byZone.values()];
    if (!zones.length || zones.some(zone=>!zone.points.length)) throw new Error("Configured demo geography does not contain verified usable service points.");
    return zones;
}

async function seedFleet() {
    validateSeedConfig();
    const client=await pool.connect();
    try {
        await client.query("BEGIN");
        const zones=await loadGeography(client);
        const policy=(await client.query("SELECT maximum_vehicle_capacity FROM drt_operating_policy WHERE is_active=TRUE ORDER BY version DESC LIMIT 1")).rows[0];
        if (!policy) throw new Error("Operating policy is missing; configure DRT policies before seeding demo fleet.");
        const capacity=Math.min(4,Number(policy.maximum_vehicle_capacity));
        if (!Number.isInteger(capacity)||capacity<1) throw new Error("Operating policy has no valid demo vehicle capacity.");
        const passwordHash=await bcrypt.hash(config.demo.accountPassword,12);
        const size=config.demo.driverPoolSizePerDirection;
        let created=0,updated=0;
        for (const [mode, direction] of [["METRO_TO_RESIDENTIAL","M2R"],["RESIDENTIAL_TO_METRO","R2M"]]) {
            for(let index=1;index<=size;index++) {
                const ordinal=String(index).padStart(2,"0");
                const prefix=`cmrl.demo.${direction.toLowerCase()}.${ordinal}`;
                const email=`${prefix}@example.test`;
                const phone=`+9198${direction==="M2R"?"21":"22"}${String(index).padStart(7,"0")}`;
                const license=`DEMO-${direction}-${ordinal}`;
                const zone=zones[(index-1)%zones.length];
                const point=zone.points[(index-1)%zone.points.length];
                const location=mode==="METRO_TO_RESIDENTIAL"?zone.station:point;
                const existing=await client.query(`SELECT d.driver_id,d.is_demo,EXISTS(SELECT 1 FROM trip t WHERE t.driver_id=d.driver_id
                  AND t.trip_status IN ('DISPATCHED','IN_PROGRESS')) AS active_trip FROM driver d WHERE d.email=$1 FOR UPDATE`,[email]);
                if(existing.rows[0]&&!existing.rows[0].is_demo) throw new Error(`Email ${email} belongs to a non-demo driver; refusing to modify it.`);
                let driverId=existing.rows[0]?.driver_id;
                if(!driverId) {
                    const inserted=await client.query(`INSERT INTO driver(full_name,email,phone_number,password_hash,driving_license_no,
                      active_zone_id,current_service_mode,shift_status,is_online,current_location,location_recorded_at,location_accuracy_m,is_demo)
                      VALUES($1,$2,$3,$4,$5,$6,$7,'AVAILABLE',TRUE,$8,clock_timestamp(),5,TRUE) RETURNING driver_id`,
                    [`DEMO ${direction} Driver ${ordinal}`,email,phone,passwordHash,license,zone.zoneId,mode,location]);
                    driverId=inserted.rows[0].driver_id;created++;
                } else if(!existing.rows[0].active_trip) {
                    await client.query(`UPDATE driver SET full_name=$2,phone_number=$3,password_hash=$4,driving_license_no=$5,
                      active_zone_id=$6,current_service_mode=$7,is_demo=TRUE,
                      shift_status=CASE WHEN EXISTS(SELECT 1 FROM trip t WHERE t.driver_id=$1 AND t.trip_status IN ('DISPATCHED','IN_PROGRESS')) THEN 'BUSY' ELSE 'AVAILABLE' END,
                      is_online=TRUE,current_location=CASE WHEN EXISTS(SELECT 1 FROM trip t WHERE t.driver_id=$1 AND t.trip_status IN ('DISPATCHED','IN_PROGRESS')) THEN current_location ELSE $8 END,
                      location_recorded_at=CASE WHEN EXISTS(SELECT 1 FROM trip t WHERE t.driver_id=$1 AND t.trip_status IN ('DISPATCHED','IN_PROGRESS')) THEN location_recorded_at ELSE clock_timestamp() END,
                      location_accuracy_m=CASE WHEN EXISTS(SELECT 1 FROM trip t WHERE t.driver_id=$1 AND t.trip_status IN ('DISPATCHED','IN_PROGRESS')) THEN location_accuracy_m ELSE 5 END
                      WHERE driver_id=$1`,[driverId,`DEMO ${direction} Driver ${ordinal}`,phone,passwordHash,license,zone.zoneId,mode,location]);
                    updated++;
                }
                const registration=`DEMO-${direction}-${ordinal}`;
                if(!existing.rows[0]?.active_trip)await client.query(`INSERT INTO vehicle(driver_id,registration_no,max_capacity,fuel_type,is_frozen_until,is_active)
                  VALUES($1,$2,$3,'DEMO',FALSE,TRUE)
                  ON CONFLICT(registration_no) DO UPDATE SET driver_id=EXCLUDED.driver_id,max_capacity=EXCLUDED.max_capacity,
                    fuel_type='DEMO',is_frozen_until=FALSE,is_active=TRUE
                  WHERE vehicle.driver_id=EXCLUDED.driver_id`,[driverId,registration,capacity]);
                const vehicle=await client.query("SELECT vehicle_id FROM vehicle WHERE driver_id=$1 AND registration_no=$2",[driverId,registration]);
                if(!vehicle.rows[0])throw new Error(`Demo vehicle ${registration} conflicts with a non-demo account.`);
            }
        }
        for(let index=1;index<=Math.min(50,config.demo.maxActiveGhostBookings);index++){
            const ordinal=String(index).padStart(2,"0"),email=`cmrl.demo.passenger.${ordinal}@example.test`;
            const phone=`+9198${"23"}${String(index).padStart(7,"0")}`;
            const existing=await client.query("SELECT user_id,is_demo FROM users WHERE email=$1 FOR UPDATE",[email]);
            if(existing.rows[0]&&!existing.rows[0].is_demo)throw new Error(`Email ${email} belongs to a non-demo passenger; refusing to modify it.`);
            if(existing.rows[0]){
                await client.query("UPDATE users SET full_name=$2,phone_number=$3,password_hash=$4,is_demo=TRUE WHERE user_id=$1",
                  [existing.rows[0].user_id,`DEMO Passenger ${ordinal}`,phone,passwordHash]);
            }else{
                await client.query("INSERT INTO users(full_name,email,phone_number,password_hash,is_demo) VALUES($1,$2,$3,$4,TRUE)",
                  [`DEMO Passenger ${ordinal}`,email,phone,passwordHash]);
            }
        }
        await client.query("COMMIT");
        console.log(`Demo fleet seeded: ${created} drivers created, ${updated} drivers refreshed; ${size} accounts per direction and ${Math.min(50,config.demo.maxActiveGhostBookings)} demo passenger accounts.`);
        console.log("Login emails use cmrl.demo.m2r.NN@example.test and cmrl.demo.r2m.NN@example.test. Use the local DEMO_ACCOUNT_PASSWORD value; passwords are not printed.");
    } catch(error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); await pool.end(); }
}

if(require.main===module) seedFleet().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={seedFleet,validateSeedConfig,loadGeography};

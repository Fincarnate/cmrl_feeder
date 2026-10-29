const pool=require("../../../db/pool");
const config=require("../../../config/env");
const policyQueries=require("../queries/policyQueries");
const bookingService=require("./bookingService");
const {exportDemoTripHistory}=require("./demoCsvExportService");
const {advanceSyntheticDemoTrips}=require("./demoTripProgressService");

let singleton=null;

function validateDemoConfig(demo=config.demo,nodeEnv=process.env.NODE_ENV||"development") {
    if(!demo.enabled)return;
    if(String(nodeEnv).toLowerCase()==="production")throw new Error("DEMO_SIMULATION_ENABLED is forbidden when NODE_ENV=production.");
    for(const [name,value] of [["DEMO_M2R_AVAILABLE_TARGET",demo.m2rAvailableTarget],["DEMO_R2M_AVAILABLE_TARGET",demo.r2mAvailableTarget]])
        if(!Number.isInteger(value)||value<1||value>50)throw new Error(`${name} must be an integer from 1 to 50.`);
    if(!Number.isInteger(demo.driverPoolSizePerDirection)||demo.driverPoolSizePerDirection<demo.m2rAvailableTarget||demo.driverPoolSizePerDirection<demo.r2mAvailableTarget||demo.driverPoolSizePerDirection>50)
        throw new Error("DEMO_DRIVER_POOL_SIZE_PER_DIRECTION must be between each available target and 50.");
    if(!Number.isInteger(demo.locationUpdateIntervalMs)||demo.locationUpdateIntervalMs<500||demo.locationUpdateIntervalMs>30000)
        throw new Error("DEMO_DRIVER_LOCATION_UPDATE_INTERVAL_MS must be from 500 to 30000 milliseconds.");
    if(!Number.isInteger(demo.ghostPassengerIntervalSeconds)||demo.ghostPassengerIntervalSeconds<10||demo.ghostPassengerIntervalSeconds>86400)
        throw new Error("DEMO_GHOST_PASSENGER_INTERVAL_SECONDS must be from 10 to 86400.");
    if(!Number.isInteger(demo.maxActiveGhostBookings)||demo.maxActiveGhostBookings<1||demo.maxActiveGhostBookings>50)
        throw new Error("DEMO_MAX_ACTIVE_GHOST_BOOKINGS must be from 1 to 50.");
    const passengerPoolSize=Number(demo.passengerPoolSize??demo.maxActiveGhostBookings);
    if(!Number.isInteger(passengerPoolSize)||passengerPoolSize<1||passengerPoolSize>50)
        throw new Error("DEMO_PASSENGER_POOL_SIZE must be an integer from 1 to 50.");
    if(demo.maxActiveGhostBookings>passengerPoolSize)
        throw new Error("DEMO_MAX_ACTIVE_GHOST_BOOKINGS cannot exceed DEMO_PASSENGER_POOL_SIZE.");
}

function directionName(value){return value==="R2M"?"RESIDENTIAL_TO_METRO":"METRO_TO_RESIDENTIAL";}

function createDemoFleetService({database=pool,logger,settings=config.demo,environment=process.env.NODE_ENV||"development"}={}) {
    validateDemoConfig(settings,environment);
    let timer=null,active=false,stopped=true,lastGhostAt=0,lastUpdateAt=null,lastError=null,shortfalls={};
    let movementStep=0;
    let ghostSequence=0;

    async function refreshIdleDrivers() {
        const policy=await policyQueries.activeOperating(database);
        const accuracy=Math.min(10,Number(config.drtStopArrivalRadiusM));
        const interval=settings.locationUpdateIntervalMs;
        if(interval>=Number(policy.driver_location_max_age_seconds)*1000)throw new Error("Demo location update interval must be shorter than the configured driver location freshness limit.");
        const {rows}=await database.query(`
          SELECT d.driver_id,d.current_service_mode,d.active_zone_id,d.is_online,d.shift_status,
            t.trip_id,v.vehicle_id,v.max_capacity,v.is_active AS vehicle_active,v.is_frozen_until,
            CASE WHEN UPPER(TRIM(d.current_service_mode)) IN ('R2M','RESIDENTIAL_TO_METRO') THEN 'R2M'
              WHEN UPPER(TRIM(d.current_service_mode)) IN ('M2R','METRO_TO_RESIDENTIAL') THEN 'M2R' END AS mode_key,
            CASE WHEN UPPER(TRIM(d.current_service_mode)) IN ('R2M','RESIDENTIAL_TO_METRO') THEN
              (SELECT sp.location_coords FROM service_point sp JOIN service_zone sz ON sz.zone_id=sp.zone_id
               WHERE sp.zone_id=d.active_zone_id AND sp.is_active=TRUE AND sp.verification_status='VERIFIED'
                 AND sp.location_coords IS NOT NULL AND sz.is_active=TRUE
                 AND EXISTS(SELECT 1 FROM metro_station ms WHERE ms.station_id=sz.station_id AND ms.is_active=TRUE
                   AND ms.service_area_polygon IS NOT NULL AND ST_Covers(ms.service_area_polygon,sz.center_coords)
                   AND ST_Covers(sz.boundary_polygon,sp.location_coords))
               ORDER BY sp.point_id OFFSET ($1::int % GREATEST((SELECT COUNT(*) FROM service_point sp2 JOIN service_zone sz2 ON sz2.zone_id=sp2.zone_id
                 JOIN metro_station ms2 ON ms2.station_id=sz2.station_id WHERE sp2.zone_id=d.active_zone_id AND sp2.is_active=TRUE
                 AND sp2.verification_status='VERIFIED' AND sp2.location_coords IS NOT NULL AND sz2.is_active=TRUE
                 AND ms2.is_active=TRUE AND ms2.service_area_polygon IS NOT NULL AND ST_Covers(ms2.service_area_polygon,sz2.center_coords)
                 AND ST_Covers(sz2.boundary_polygon,sp2.location_coords)),1)) LIMIT 1)
              ELSE CASE WHEN $2::boolean AND $1::int%2=1 THEN
                (SELECT sp.location_coords FROM service_point sp JOIN service_zone sz ON sz.zone_id=sp.zone_id
                 WHERE sp.zone_id=d.active_zone_id AND sp.is_active=TRUE AND sp.verification_status='VERIFIED'
                   AND sp.location_coords IS NOT NULL AND sz.is_active=TRUE
                   AND EXISTS(SELECT 1 FROM metro_station ms WHERE ms.station_id=sz.station_id AND ms.is_active=TRUE
                     AND ms.service_area_polygon IS NOT NULL AND ST_Covers(ms.service_area_polygon,sz.center_coords)
                     AND ST_Covers(sz.boundary_polygon,sp.location_coords)) ORDER BY sp.point_id LIMIT 1)
                ELSE (SELECT ms.station_coords FROM service_zone sz JOIN metro_station ms ON ms.station_id=sz.station_id
                  WHERE sz.zone_id=d.active_zone_id AND sz.is_active=TRUE AND ms.is_active=TRUE
                    AND ms.station_coords IS NOT NULL AND ms.service_area_polygon IS NOT NULL
                    AND ST_Covers(ms.service_area_polygon,sz.center_coords)) END END AS next_location
          FROM driver d LEFT JOIN vehicle v ON v.driver_id=d.driver_id AND v.is_active=TRUE
          LEFT JOIN LATERAL (SELECT trip_id FROM trip WHERE driver_id=d.driver_id AND trip_status IN ('DISPATCHED','IN_PROGRESS') LIMIT 1) t ON TRUE
          WHERE d.is_demo=TRUE ORDER BY d.current_service_mode,d.email,v.vehicle_id`,[movementStep,settings.movementEnabled]);
        const touched=new Set();
        for(const driver of rows){
            if(touched.has(driver.driver_id))continue;touched.add(driver.driver_id);
            if(driver.trip_id){
                await database.query("UPDATE driver SET shift_status='BUSY' WHERE driver_id=$1 AND is_demo=TRUE AND shift_status<>'BUSY'",[driver.driver_id]);
                continue;
            }
            if(!driver.vehicle_id||!driver.vehicle_active||driver.is_frozen_until||Number(driver.max_capacity)<1||Number(driver.max_capacity)>Number(policy.maximum_vehicle_capacity)||!driver.next_location)continue;
            const mode=driver.mode_key;
            if(!["M2R","R2M"].includes(mode))continue;
            await database.query(`UPDATE driver SET is_online=TRUE,shift_status='AVAILABLE',
              current_location=$2,location_recorded_at=clock_timestamp(),location_accuracy_m=$3
              WHERE driver_id=$1 AND is_demo=TRUE
                AND NOT EXISTS(SELECT 1 FROM trip t WHERE t.driver_id=$1 AND t.trip_status IN ('DISPATCHED','IN_PROGRESS'))
                AND NOT EXISTS(SELECT 1 FROM trip t JOIN vehicle v ON v.vehicle_id=t.vehicle_id WHERE v.driver_id=$1 AND t.trip_status IN ('DISPATCHED','IN_PROGRESS'))
                AND EXISTS(SELECT 1 FROM vehicle v WHERE v.driver_id=$1 AND v.vehicle_id=$4 AND v.is_active=TRUE
                  AND COALESCE(v.is_frozen_until,FALSE)=FALSE AND v.max_capacity BETWEEN 1 AND $5)`,
            [driver.driver_id,driver.next_location,accuracy,driver.vehicle_id,Number(policy.maximum_vehicle_capacity)]);
        }
        if(settings.movementEnabled)movementStep++;
        const counts=await database.query(`SELECT mode_key,COUNT(*) FILTER(WHERE eligible)::int AS available,
          COUNT(*) FILTER(WHERE active_trip)::int AS busy,COUNT(DISTINCT vehicle_id)::int AS vehicles,
          MAX(location_recorded_at) AS latest_update FROM (
            SELECT CASE WHEN UPPER(TRIM(d.current_service_mode)) IN ('R2M','RESIDENTIAL_TO_METRO') THEN 'R2M'
              WHEN UPPER(TRIM(d.current_service_mode)) IN ('M2R','METRO_TO_RESIDENTIAL') THEN 'M2R' END AS mode_key,
              d.location_recorded_at,
              EXISTS(SELECT 1 FROM trip t WHERE t.driver_id=d.driver_id AND t.trip_status IN ('DISPATCHED','IN_PROGRESS')) AS active_trip,
              v.vehicle_id,
              d.is_online AND UPPER(d.shift_status) IN ('AVAILABLE','ONLINE') AND d.current_location IS NOT NULL
                AND d.location_recorded_at>clock_timestamp()-($1::int*interval '1 second')
                AND d.location_accuracy_m IS NOT NULL AND d.location_accuracy_m<=$2
                AND v.is_active=TRUE AND COALESCE(v.is_frozen_until,FALSE)=FALSE AND v.max_capacity BETWEEN 1 AND $3
                AND NOT EXISTS(SELECT 1 FROM trip t WHERE (t.driver_id=d.driver_id OR t.vehicle_id=v.vehicle_id) AND t.trip_status IN ('DISPATCHED','IN_PROGRESS')) AS eligible
            FROM driver d LEFT JOIN vehicle v ON v.driver_id=d.driver_id AND v.is_active=TRUE WHERE d.is_demo=TRUE
          ) fleet GROUP BY mode_key` , [Number(policy.driver_location_max_age_seconds),Number(config.drtStopArrivalRadiusM),Number(policy.maximum_vehicle_capacity)]);
        const byMode=Object.fromEntries(counts.rows.map(row=>[row.mode_key,row]));
        shortfalls={M2R:Math.max(0,settings.m2rAvailableTarget-Number(byMode.M2R?.available||0)),R2M:Math.max(0,settings.r2mAvailableTarget-Number(byMode.R2M?.available||0))};
        lastUpdateAt=new Date().toISOString();
        return {policy,byMode};
    }

    async function maybeCreateGhostBooking() {
        if(!settings.ghostPassengersEnabled)return false;
        const now=Date.now();
        if(now-lastGhostAt<settings.ghostPassengerIntervalSeconds*1000)return false;
        lastGhostAt=now;
        const active=await database.query(`SELECT COUNT(*)::int AS count FROM booking b JOIN users u ON u.user_id=b.user_id
          WHERE u.is_demo=TRUE AND b.booking_status IN ('REQUESTED','ASSIGNED','BOARDING','IN_PROGRESS')`);
        if(Number(active.rows[0].count)>=settings.maxActiveGhostBookings)return false;
        const candidates=await database.query(`SELECT u.user_id,u.full_name,u.email,service.station_id,service.zone_id,service.point_id
          FROM users u CROSS JOIN LATERAL (
            SELECT ms.station_id,sz.zone_id,sp.point_id FROM metro_station ms JOIN service_zone sz ON sz.station_id=ms.station_id
            JOIN service_point sp ON sp.zone_id=sz.zone_id
            WHERE ms.is_active=TRUE AND sz.is_active=TRUE AND sp.is_active=TRUE AND sp.verification_status='VERIFIED'
              AND ms.station_coords IS NOT NULL AND ms.service_area_polygon IS NOT NULL AND sz.boundary_polygon IS NOT NULL
              AND sz.center_coords IS NOT NULL AND ST_Covers(ms.service_area_polygon,sz.center_coords)
              AND ST_Covers(sz.boundary_polygon,sp.location_coords) ORDER BY ms.station_name,sz.zone_name,sp.point_name LIMIT 1
          ) service
          WHERE u.is_demo=TRUE AND NOT EXISTS(SELECT 1 FROM booking b WHERE b.user_id=u.user_id
            AND b.booking_status IN ('REQUESTED','ASSIGNED','BOARDING','IN_PROGRESS'))
          ORDER BY (SELECT COUNT(*) FROM booking history WHERE history.user_id=u.user_id AND history.idempotency_key LIKE 'demo-ghost:%'),
            (SELECT MAX(history.created_at) FROM booking history WHERE history.user_id=u.user_id AND history.idempotency_key LIKE 'demo-ghost:%') NULLS FIRST,
            u.email LIMIT 1`);
        const passenger=candidates.rows[0];if(!passenger)return false;
        const direction=ghostSequence++%2===0?"RESIDENTIAL_TO_METRO":"METRO_TO_RESIDENTIAL";
        const operating=await policyQueries.activeOperating(database);
        const localParts=new Intl.DateTimeFormat("en-GB",{timeZone:operating.timezone,hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date(now+60000));
        const timePart=type=>localParts.find(part=>part.type===type)?.value;
        const dailyDepartureTime=`${timePart("hour")}:${timePart("minute")}`;
        const input={direction,stationId:passenger.station_id,zoneId:passenger.zone_id,servicePointId:passenger.point_id,
          seatsRequested:1,bookingIntent:"BOOKING",dailyDepartureTime,originLocationSource:"MANUAL",latitude:null,longitude:null,pickupAcknowledged:false};
        const quote=await bookingService.previewFare(input);
        await bookingService.createBooking(passenger.user_id,{...input,quoteToken:quote.quoteToken,idempotencyKey:`demo-ghost:${passenger.user_id}:${Math.floor(now/(settings.ghostPassengerIntervalSeconds*1000))}`});
        try { await exportDemoTripHistory(); }
        catch(error) { logger?.error({err:error,passengerId:passenger.user_id},"Unable to refresh demo trip history CSV after synthetic booking creation."); }
        logger?.info({event:"demo_ghost_booking_created",passengerId:passenger.user_id,direction},"Created bounded synthetic demo booking through the normal booking service.");
        return true;
    }

    async function iteration(){
        if(stopped||active)return;
        active=true;
        try {const result=await refreshIdleDrivers();const progress=await advanceSyntheticDemoTrips({database,settings,logger});await maybeCreateGhostBooking();lastError=progress.lastError;logger?.debug({event:"demo_fleet_refreshed",shortfalls,advancedStops:progress.advanced,completedTrips:progress.completed},"Refreshed eligible idle demo drivers.");return result;}
        catch(error){lastError=error.message;logger?.error({event:"demo_fleet_error",message:error.message},"Demo fleet iteration failed.");}
        finally{active=false;if(!stopped)timer=setTimeout(iteration,settings.locationUpdateIntervalMs);}
    }
    return {
        async start(){
            if(!settings.enabled)return false;
            validateDemoConfig(settings,environment);
            if(!stopped)return false;
            stopped=false;timer=setTimeout(iteration,0);logger?.info({event:"demo_fleet_started",movement:settings.movementEnabled,ghostPassengers:settings.ghostPassengersEnabled},"Demo fleet simulator started.");return true;
        },
        async stop(){stopped=true;if(timer)clearTimeout(timer);while(active)await new Promise(resolve=>setTimeout(resolve,20));logger?.info({event:"demo_fleet_stopped"},"Demo fleet simulator stopped.");},
        async getStatus(){
            if(!settings.enabled)return {enabled:false,shortfalls:{},lastUpdateAt:null,lastError:null,ghostPassengersEnabled:false,autoCompleteTrips:false,drivers:{},vehicles:0,activeGhostBookings:0};
            const {rows}=await database.query(`SELECT CASE WHEN UPPER(TRIM(d.current_service_mode)) IN ('M2R','METRO_TO_RESIDENTIAL') THEN 'M2R'
              WHEN UPPER(TRIM(d.current_service_mode)) IN ('R2M','RESIDENTIAL_TO_METRO') THEN 'R2M' END AS direction,
              COUNT(DISTINCT d.driver_id) FILTER(WHERE d.is_online)::int AS online,COUNT(DISTINCT d.driver_id) FILTER(WHERE d.is_online AND UPPER(d.shift_status) IN ('AVAILABLE','ONLINE')
                AND d.current_location IS NOT NULL AND d.location_recorded_at>clock_timestamp()-($1::int*interval '1 second') AND d.location_accuracy_m IS NOT NULL AND d.location_accuracy_m<=$2
                AND v.is_active=TRUE AND COALESCE(v.is_frozen_until,FALSE)=FALSE AND v.max_capacity BETWEEN 1 AND $3
                AND NOT EXISTS(SELECT 1 FROM trip t WHERE (t.driver_id=d.driver_id OR t.vehicle_id=v.vehicle_id) AND t.trip_status IN ('DISPATCHED','IN_PROGRESS')))::int AS available,
              COUNT(DISTINCT d.driver_id) FILTER(WHERE EXISTS(SELECT 1 FROM trip t WHERE t.driver_id=d.driver_id AND t.trip_status IN ('DISPATCHED','IN_PROGRESS')))::int AS busy,
              COUNT(DISTINCT v.vehicle_id)::int AS vehicles,MAX(d.location_recorded_at) AS latest_update
              FROM driver d LEFT JOIN vehicle v ON v.driver_id=d.driver_id WHERE d.is_demo=TRUE GROUP BY direction`,
            [Number((await policyQueries.activeOperating(database)).driver_location_max_age_seconds),Number(config.drtStopArrivalRadiusM),Number((await policyQueries.activeOperating(database)).maximum_vehicle_capacity)]);
            const ghost=await database.query(`SELECT COUNT(*)::int AS count FROM booking b JOIN users u ON u.user_id=b.user_id WHERE u.is_demo=TRUE AND b.booking_status IN ('REQUESTED','ASSIGNED','BOARDING','IN_PROGRESS')`);
            const drivers=Object.fromEntries(rows.map(row=>[row.direction,{online:row.online,available:row.available,busy:row.busy,vehicles:row.vehicles,latestUpdate:row.latest_update}]));
            const poolSize=(await database.query("SELECT COUNT(*)::int AS count FROM driver WHERE is_demo=TRUE")).rows[0].count;
            return {enabled:true,movementEnabled:settings.movementEnabled,ghostPassengersEnabled:settings.ghostPassengersEnabled,autoCompleteTrips:settings.autoCompleteTrips,
              target:{M2R:settings.m2rAvailableTarget,R2M:settings.r2mAvailableTarget},poolSize,lastUpdateAt,lastError,shortfalls,
              drivers,vehicles:rows.reduce((sum,row)=>sum+Number(row.vehicles),0),activeGhostBookings:Number(ghost.rows[0].count)};
        }
    };
}

function getDemoFleetService(options){if(!singleton)singleton=createDemoFleetService(options);return singleton;}
function resetDemoFleetServiceForTests(){singleton=null;}
module.exports={createDemoFleetService,getDemoFleetService,validateDemoConfig,resetDemoFleetServiceForTests};

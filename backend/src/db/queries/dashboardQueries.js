const pool = require("../pool");

async function getDashboardSummary() {
    const query = `
        SELECT
            (
                SELECT COUNT(*)
                FROM driver
                WHERE is_online=TRUE AND UPPER(COALESCE(shift_status, '')) = 'AVAILABLE'
                  AND NOT EXISTS (SELECT 1 FROM trip t WHERE t.driver_id=driver.driver_id AND t.trip_status IN ('DISPATCHED','IN_PROGRESS'))
            ) AS available_drivers,
            (
                SELECT COUNT(*)
                FROM users
            ) AS total_passengers,
            (
                SELECT COUNT(*) FROM booking
                WHERE UPPER(COALESCE(booking_status, '')) IN ('REQUESTED', 'ASSIGNED', 'BOARDING', 'IN_PROGRESS')
            ) AS active_bookings,
            (
                SELECT COUNT(*) FROM driver WHERE is_online=TRUE
            ) AS online_drivers
    `;

    const result = await pool.query(query);
    const summary = result.rows[0];

    return {
        availableDrivers: Number(summary.available_drivers),
        onlineDrivers: Number(summary.online_drivers),
        totalPassengers: Number(summary.total_passengers),
        activeBookings: Number(summary.active_bookings)
    };
}

async function getDashboardMapData() {
    const query = `
      SELECT
        COALESCE((SELECT json_agg(json_build_object('id', station_id, 'name', station_name,
          'coordinates', CASE WHEN station_coords IS NULL THEN NULL ELSE ST_AsGeoJSON(station_coords)::json END,
          'boundary', CASE WHEN service_boundary_polygon IS NULL THEN NULL ELSE ST_AsGeoJSON(service_boundary_polygon)::json END,
          'serviceArea',CASE WHEN service_area_polygon IS NULL THEN NULL ELSE ST_AsGeoJSON(service_area_polygon)::json END,
          'serviceRadiusKm',service_radius_km,'geofenceRadiusMeters',station_geofence_radius_m,
          'geofenceSource',station_geofence_source,'serviceAreaSource',service_area_source)) FROM metro_station WHERE is_active = TRUE), '[]'::json) AS stations,
        COALESCE((SELECT json_agg(json_build_object('id', zone_id, 'name', zone_name, 'stationId', station_id,
          'boundary', CASE WHEN boundary_polygon IS NULL THEN NULL ELSE ST_AsGeoJSON(boundary_polygon)::json END,
          'center',CASE WHEN center_coords IS NULL THEN NULL ELSE ST_AsGeoJSON(center_coords)::json END,
          'radiusKm',service_radius_km,'boundarySource',boundary_source)) FROM service_zone WHERE is_active = TRUE), '[]'::json) AS zones,
        COALESCE((SELECT json_agg(json_build_object('id', point_id, 'name', point_name, 'zoneId', zone_id,
          'coordinates', CASE WHEN location_coords IS NULL THEN NULL ELSE ST_AsGeoJSON(location_coords)::json END,
          'verificationStatus',verification_status,'coordinateSource',coordinate_source,'active',is_active,
          'bookable',is_active AND verification_status='VERIFIED' AND location_coords IS NOT NULL AND
            EXISTS(SELECT 1 FROM service_zone sz WHERE sz.zone_id=service_point.zone_id AND ST_Covers(sz.boundary_polygon,service_point.location_coords)))) FROM service_point), '[]'::json) AS service_points,
        COALESCE((SELECT json_agg(json_build_object('id', d.driver_id, 'name', d.full_name, 'recordedAt', d.location_recorded_at,
          'coordinates', ST_AsGeoJSON(d.current_location)::json)) FROM driver d
          WHERE d.is_online=TRUE AND d.current_location IS NOT NULL AND d.location_recorded_at > clock_timestamp() -
            (COALESCE((SELECT driver_location_max_age_seconds FROM drt_operating_policy WHERE is_active=TRUE ORDER BY version DESC LIMIT 1),90)*INTERVAL '1 second')), '[]'::json) AS driver_locations
    `;
    const { rows } = await pool.query(query);
    const row = rows[0];
    return { stations: row.stations, zones: row.zones, servicePoints: row.service_points, driverLocations: row.driver_locations, passengerLocations: [], passengerLocationAvailability: "Passenger location telemetry is not stored by the current schema." };
}

async function getDashboardOperations() {
    const [trips, bookings, events] = await Promise.all([
        pool.query(`SELECT t.trip_id,t.trip_direction,t.trip_status,t.dispatch_started_at,t.dispatch_deadline,t.dispatched_at,
            t.seat_capacity,ms.station_name,d.full_name AS driver_name,v.registration_no,
            COALESCE(SUM(b.seats_reserved) FILTER (WHERE UPPER(b.booking_status) IN ('REQUESTED','ASSIGNED','BOARDING','IN_PROGRESS')),0)::int AS occupied_seats,
            COUNT(b.booking_id) FILTER (WHERE UPPER(b.booking_status)='NO_SHOW')::int AS no_shows,
            COALESCE(json_agg(json_build_object('bookingId',b.booking_id,'status',b.booking_status,'seats',b.seats_reserved,'fare',b.fare_amount,'currency',b.fare_currency,'deadline',b.boarding_deadline) ORDER BY b.requested_at) FILTER (WHERE b.booking_id IS NOT NULL),'[]'::json) AS bookings
            FROM trip t LEFT JOIN metro_station ms ON ms.station_id=t.station_id LEFT JOIN driver d ON d.driver_id=t.driver_id LEFT JOIN vehicle v ON v.vehicle_id=t.vehicle_id
            LEFT JOIN booking b ON b.trip_id=t.trip_id
            WHERE t.trip_status IN ('WAITING_FOR_PASSENGERS','READY_TO_DISPATCH','DISPATCHED','IN_PROGRESS')
            GROUP BY t.trip_id,ms.station_name,d.full_name,v.registration_no ORDER BY t.dispatch_deadline NULLS LAST LIMIT 100`),
        pool.query(`SELECT booking_id,booking_status,requested_at,boarding_deadline,driver_arrived_at,completed_at,cancelled_at,fare_amount,fare_currency,direction
            FROM booking WHERE UPPER(booking_status) IN ('NO_SHOW','CANCELLED','COMPLETED','FAILED') ORDER BY requested_at DESC LIMIT 100`),
        pool.query(`SELECT event_id,event_type,trip_id,booking_id,details,created_at FROM drt_engine_event
            WHERE event_type IN ('DISPATCH_FAILED','DISPATCH_RETRY_SCHEDULED','PASSENGER_NO_SHOW') ORDER BY created_at DESC LIMIT 50`)
    ]);
    return { activeTrips:trips.rows, resolvedBookings:bookings.rows, recentFailures:events.rows };
}

module.exports = {
    getDashboardSummary,
    getDashboardMapData,
    getDashboardOperations
};

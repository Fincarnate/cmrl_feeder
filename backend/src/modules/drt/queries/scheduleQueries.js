const pool = require("../../../db/pool");

async function nextDeparture(client, dailyDepartureTime, timezone) {
    const { rows } = await client.query(`
      WITH clock AS (
        SELECT clock_timestamp() AS now_at, (clock_timestamp() AT TIME ZONE $2)::date AS local_date
      ), candidates AS (
        SELECT local_date + offset_days AS service_date, now_at
        FROM clock CROSS JOIN generate_series(0,1) AS days(offset_days)
      )
      SELECT service_date::text,
        (service_date + $1::time) AT TIME ZONE $2 AS departure_at
      FROM candidates
      WHERE (service_date + $1::time) AT TIME ZONE $2 > now_at
      ORDER BY service_date LIMIT 1
    `, [dailyDepartureTime, timezone]);
    return rows[0] || null;
}

async function departureAtDate(client, serviceDate, dailyDepartureTime, timezone) {
    const { rows } = await client.query(`SELECT $1::date::text AS service_date,
      ($1::date + $2::time) AT TIME ZONE $3 AS departure_at`, [serviceDate,dailyDepartureTime,timezone]);
    return rows[0];
}

async function findIdempotentSchedule(client, userId, key) {
    if (!key) return null;
    const { rows } = await client.query(`SELECT * FROM recurring_booking_schedule WHERE user_id=$1 AND idempotency_key=$2`, [userId,key]);
    return rows[0] || null;
}

async function insertSchedule(client, input) {
    const { rows } = await client.query(`
      INSERT INTO recurring_booking_schedule(user_id,direction,station_id,zone_id,service_point_id,seats_reserved,
        daily_departure_time,timezone,origin_location_source,pickup_acknowledged,idempotency_key,next_service_date,next_departure_at)
      VALUES($1,$2,$3,$4,$5,$6,$7::time,$8,$9,$10,$11,$12::date,$13::timestamptz)
      RETURNING *
    `, [input.userId,input.direction,input.stationId,input.zoneId,input.servicePointId,input.seats,input.dailyDepartureTime,
        input.timezone,input.originLocationSource,input.pickupAcknowledged,input.idempotencyKey || null,input.serviceDate,input.departureAt]);
    return rows[0];
}

async function listMySchedules(userId) {
    const { rows } = await pool.query(`
      SELECT s.schedule_id,s.direction,s.station_id,s.zone_id,s.service_point_id,s.seats_reserved,
        s.daily_departure_time::text,s.timezone,s.schedule_status,s.next_service_date::text,s.next_departure_at,
        s.created_at,s.cancelled_at,ms.station_name,sz.zone_name,sp.point_name,
        COALESCE((
          SELECT json_agg(json_build_object(
            'occurrenceId',recent.occurrence_id,'serviceDate',recent.service_date::text,
            'scheduledAt',recent.scheduled_at,'status',CASE WHEN recent.occurrence_status='MISSED' THEN 'MISSED'
              ELSE COALESCE(t.trip_status,b.booking_status,'REQUESTED') END,
            'bookingId',recent.booking_id,'bookingStatus',b.booking_status,
            'tripId',recent.trip_id,'tripStatus',t.trip_status,'fare',b.fare_amount,'currency',b.fare_currency,
            'driverName',d.full_name,'vehicleRegistration',v.registration_no,'dispatchDeadline',t.dispatch_deadline
          ) ORDER BY recent.service_date DESC)
          FROM (
            SELECT o.* FROM recurring_booking_occurrence o
            WHERE o.schedule_id=s.schedule_id ORDER BY o.service_date DESC LIMIT 14
          ) recent
          LEFT JOIN booking b ON b.booking_id=recent.booking_id
          LEFT JOIN trip t ON t.trip_id=recent.trip_id
          LEFT JOIN driver d ON d.driver_id=t.driver_id
          LEFT JOIN vehicle v ON v.vehicle_id=t.vehicle_id
        ),'[]'::json) AS occurrences
      FROM recurring_booking_schedule s
      JOIN metro_station ms ON ms.station_id=s.station_id
      JOIN service_zone sz ON sz.zone_id=s.zone_id
      JOIN service_point sp ON sp.point_id=s.service_point_id
      WHERE s.user_id=$1 ORDER BY s.created_at DESC
    `, [userId]);
    return rows;
}

async function getScheduleForUser(userId, scheduleId) {
    const { rows } = await pool.query(`SELECT * FROM recurring_booking_schedule WHERE user_id=$1 AND schedule_id=$2`, [userId,scheduleId]);
    return rows[0] || null;
}

async function cancelSchedule(userId, scheduleId) {
    const client=await pool.connect();
    try {
        await client.query("BEGIN");
        const { rows } = await client.query(`UPDATE recurring_booking_schedule
          SET schedule_status='CANCELLED',next_service_date=NULL,next_departure_at=NULL,cancelled_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE user_id=$1 AND schedule_id=$2 AND schedule_status='ACTIVE' RETURNING *`, [userId,scheduleId]);
        const schedule = rows[0] || (await client.query("SELECT * FROM recurring_booking_schedule WHERE user_id=$1 AND schedule_id=$2 FOR UPDATE", [userId,scheduleId])).rows[0];
        await client.query("COMMIT");
        return schedule || null;
    } catch(error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
}

module.exports = { nextDeparture, departureAtDate, findIdempotentSchedule, insertSchedule, listMySchedules, getScheduleForUser, cancelSchedule };

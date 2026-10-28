const pool = require("../../../db/pool");
const scheduleQueries = require("../queries/scheduleQueries");
const bookingService = require("./bookingService");

const MISFIRE_GRACE_MS = 60_000;

function addCalendarDay(isoDate) {
    const [year,month,day]=isoDate.split("-").map(Number);
    const next=new Date(Date.UTC(year,month-1,day+1));
    return `${next.getUTCFullYear()}-${String(next.getUTCMonth()+1).padStart(2,"0")}-${String(next.getUTCDate()).padStart(2,"0")}`;
}

function departureDisposition(nowMs,departureMs,graceMs=MISFIRE_GRACE_MS) {
    if(nowMs<departureMs)return "NOT_DUE";
    return nowMs-departureMs>graceMs?"MISSED":"DUE";
}

async function recordMissedRange(client,schedule,fromDate,toDate) {
    if(fromDate>toDate)return 0;
    const result=await client.query(`INSERT INTO recurring_booking_occurrence(schedule_id,service_date,scheduled_at,occurrence_status)
      SELECT s.schedule_id,d.service_date,(d.service_date+s.daily_departure_time) AT TIME ZONE s.timezone,'MISSED'
      FROM recurring_booking_schedule s
      CROSS JOIN LATERAL generate_series($2::date,$3::date,interval '1 day') AS days(day_value)
      CROSS JOIN LATERAL (SELECT days.day_value::date AS service_date) d
      WHERE s.schedule_id=$1 ON CONFLICT(schedule_id,service_date) DO NOTHING`,[schedule.schedule_id,fromDate,toDate]);
    return result.rowCount;
}

async function markMissed(client,schedule,serviceDate,scheduledAt) {
    await client.query(`INSERT INTO recurring_booking_occurrence(schedule_id,service_date,scheduled_at,occurrence_status)
      VALUES($1,$2::date,$3::timestamptz,'MISSED') ON CONFLICT(schedule_id,service_date) DO NOTHING`,
    [schedule.schedule_id,serviceDate,scheduledAt]);
}

async function setNextDeparture(client,schedule,serviceDate) {
    const next=await scheduleQueries.departureAtDate(client,serviceDate,schedule.daily_departure_time,schedule.timezone);
    await client.query(`UPDATE recurring_booking_schedule SET next_service_date=$2::date,next_departure_at=$3::timestamptz,
      updated_at=clock_timestamp() WHERE schedule_id=$1`,[schedule.schedule_id,next.service_date,next.departure_at]);
}

async function materializeOneDueSchedule(database=pool,scheduleId=null) {
    const client=await database.connect();
    try {
        await client.query("BEGIN");
        const {rows}=await client.query(`SELECT *,next_service_date::text AS next_service_date_iso FROM recurring_booking_schedule
          WHERE schedule_status='ACTIVE' AND next_departure_at<=clock_timestamp()
            AND ($1::uuid IS NULL OR schedule_id=$1)
          ORDER BY next_departure_at,schedule_id FOR UPDATE SKIP LOCKED LIMIT 1`,[scheduleId]);
        const schedule=rows[0];
        if(!schedule){await client.query("COMMIT");return {processed:false};}

        const clock=(await client.query(`SELECT clock_timestamp() AS now_at,
          (clock_timestamp() AT TIME ZONE $1)::date::text AS local_date`,[schedule.timezone])).rows[0];
        const today=clock.local_date;
        let serviceDate=schedule.next_service_date_iso;
        const nowMs=new Date(clock.now_at).getTime();

        // Record old service dates as missed instead of launching late trips after downtime.
        if(serviceDate<today){
            // Use PostgreSQL date arithmetic for the previous local date (including month/year boundaries).
            const previous=(await client.query("SELECT ($1::date-1)::text AS date",[today])).rows[0].date;
            await recordMissedRange(client,schedule,serviceDate,previous);
            serviceDate=today;
        }

        if(serviceDate>today){
            await setNextDeparture(client,schedule,serviceDate);
            await client.query("COMMIT");
            return {processed:true,outcome:"SCHEDULE_RECONCILED",scheduleId:schedule.schedule_id};
        }

        const departure=serviceDate===schedule.next_service_date_iso
            ? {departure_at:schedule.next_departure_at}
            : await scheduleQueries.departureAtDate(client,serviceDate,schedule.daily_departure_time,schedule.timezone);
        const departureMs=new Date(departure.departure_at).getTime();
        const disposition=departureDisposition(nowMs,departureMs);
        if(disposition==="NOT_DUE"){
            await setNextDeparture(client,schedule,serviceDate);
            await client.query("COMMIT");
            return {processed:true,outcome:"SCHEDULE_RECONCILED",scheduleId:schedule.schedule_id};
        }

        if(disposition==="MISSED"){
            await markMissed(client,schedule,serviceDate,departure.departure_at);
            const nextDate=addCalendarDay(serviceDate);
            await setNextDeparture(client,schedule,nextDate);
            await client.query("COMMIT");
            return {processed:true,outcome:"SCHEDULE_MISSED",scheduleId:schedule.schedule_id,serviceDate};
        }

        const existing=await client.query(`SELECT occurrence_id FROM recurring_booking_occurrence
          WHERE schedule_id=$1 AND service_date=$2::date`,[schedule.schedule_id,serviceDate]);
        if(existing.rows[0]){
            await setNextDeparture(client,schedule,addCalendarDay(serviceDate));
            await client.query("COMMIT");
            return {processed:true,outcome:"SCHEDULE_ALREADY_MATERIALIZED",scheduleId:schedule.schedule_id,serviceDate};
        }

        const booking=await bookingService.createScheduledOccurrence(client,schedule,departure.departure_at,serviceDate);
        await client.query(`INSERT INTO recurring_booking_occurrence(schedule_id,service_date,scheduled_at,occurrence_status,booking_id,trip_id)
          VALUES($1,$2::date,$3::timestamptz,'CREATED',$4,$5)`,
        [schedule.schedule_id,serviceDate,departure.departure_at,booking.booking_id,booking.trip_id]);
        await setNextDeparture(client,schedule,addCalendarDay(serviceDate));
        await client.query("COMMIT");
        return {processed:true,outcome:"SCHEDULE_MATERIALIZED",scheduleId:schedule.schedule_id,serviceDate,tripId:booking.trip_id};
    } catch(error){await client.query("ROLLBACK");throw error;}
    finally{client.release();}
}

module.exports={materializeOneDueSchedule,addCalendarDay,departureDisposition,MISFIRE_GRACE_MS};

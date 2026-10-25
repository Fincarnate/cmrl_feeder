const pool = require("../../../db/pool");
const { dispatchOne } = require("./dispatchService");
const { assertTransition } = require("./bookingStates");

async function resolveOneNoShow() {
    const client=await pool.connect();
    try {
        await client.query("BEGIN");
        const { rows }=await client.query(`SELECT booking_id,trip_id,service_point_id FROM booking
            WHERE booking_status='BOARDING' AND boarding_deadline<=clock_timestamp()
            ORDER BY boarding_deadline FOR UPDATE SKIP LOCKED LIMIT 1`);
        if(!rows[0]) { await client.query("COMMIT"); return false; }
        const booking=rows[0];
        assertTransition("BOARDING", "NO_SHOW");
        await client.query("UPDATE booking SET booking_status='NO_SHOW',otp_hash=NULL,otp_expires_at=NULL WHERE booking_id=$1 AND booking_status='BOARDING'",[booking.booking_id]);
        await client.query(`UPDATE trip t SET available_seats=GREATEST(0,
            COALESCE(t.seat_capacity,NULLIF((t.dispatch_policy->>'maximumVehicleCapacity')::int,0),t.available_seats,0)-
            COALESCE((SELECT SUM(b.seats_reserved) FROM booking b WHERE b.trip_id=t.trip_id AND UPPER(b.booking_status) IN ('REQUESTED','ASSIGNED','BOARDING','IN_PROGRESS')),0))
            WHERE t.trip_id=$1`,[booking.trip_id]);
        await client.query("INSERT INTO drt_engine_event(event_type,trip_id,booking_id,actor_role) VALUES('PASSENGER_NO_SHOW',$1,$2,'SYSTEM')",[booking.trip_id,booking.booking_id]);
        const remainingAtStop=await client.query("SELECT 1 FROM booking WHERE trip_id=$1 AND service_point_id=$2 AND UPPER(booking_status) IN ('ASSIGNED','BOARDING','IN_PROGRESS') LIMIT 1",[booking.trip_id,booking.service_point_id]);
        if(!remainingAtStop.rows[0]) await client.query(`UPDATE trip_stop_sequence s SET completed_at=clock_timestamp(),stop_status='SKIPPED'
            WHERE s.trip_id=$1 AND s.point_id=$2 AND s.stop_type='SERVICE_POINT' AND s.arrived_at IS NULL
              AND EXISTS(SELECT 1 FROM trip t WHERE t.trip_id=s.trip_id AND t.trip_direction='METRO_TO_RESIDENTIAL')`,[booking.trip_id,booking.service_point_id]);
        const active=await client.query("SELECT 1 FROM booking WHERE trip_id=$1 AND UPPER(booking_status) IN ('REQUESTED','ASSIGNED','BOARDING','IN_PROGRESS') LIMIT 1",[booking.trip_id]);
        if(!active.rows[0]) {
            await client.query("UPDATE trip_stop_sequence SET completed_at=COALESCE(completed_at,clock_timestamp()),stop_status='SKIPPED' WHERE trip_id=$1 AND completed_at IS NULL",[booking.trip_id]);
            await client.query("UPDATE trip SET trip_status='CANCELLED',completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE trip_id=$1 AND trip_status IN ('DISPATCHED','IN_PROGRESS')",[booking.trip_id]);
            await client.query("UPDATE driver SET shift_status=CASE WHEN is_online THEN 'AVAILABLE' ELSE 'OFFLINE' END WHERE driver_id=(SELECT driver_id FROM trip WHERE trip_id=$1)",[booking.trip_id]);
            await client.query("INSERT INTO drt_engine_event(event_type,trip_id,actor_role,details) VALUES('TRIP_CANCELLED_NO_ACTIVE_PASSENGERS',$1,'SYSTEM','{}'::jsonb)",[booking.trip_id]);
        }
        await client.query("COMMIT"); return true;
    } catch(error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

async function clearExpiredOtp() {
    const { rowCount }=await pool.query("UPDATE booking SET otp_hash=NULL WHERE otp_hash IS NOT NULL AND otp_expires_at<=clock_timestamp() AND booking_status='BOARDING'");
    return rowCount;
}

function createWorker({logger,intervalMs=1000}) {
    if (!Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 60000) throw new Error("DRT worker interval must be an integer from 100 to 60000 milliseconds.");
    let timer=null;
    let stopped=true;
    let active=false;
    async function tick() {
        if(stopped||active)return;
        active=true;
        try {
            await resolveOneNoShow();
            await clearExpiredOtp();
            const dispatch=await dispatchOne();
            if(dispatch.processed) logger?.info({event:"drt_dispatch_worker",outcome:dispatch.outcome,tripId:dispatch.tripId},"DRT worker processed a trip");
        } catch(error) { logger?.error({event:"drt_worker_error",code:error.code,message:error.message},"DRT worker iteration failed"); }
        finally { active=false; if(!stopped)timer=setTimeout(tick,intervalMs); }
    }
    return {
        start(){if(stopped){stopped=false;timer=setTimeout(tick,0);}},
        async stop(){stopped=true;if(timer)clearTimeout(timer);while(active)await new Promise(resolve=>setTimeout(resolve,20));}
    };
}

module.exports={resolveOneNoShow,clearExpiredOtp,createWorker};

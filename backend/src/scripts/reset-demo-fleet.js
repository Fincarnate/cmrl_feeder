const pool=require("../db/pool");
const config=require("../config/env");

async function reset(){
    if((process.env.NODE_ENV||"").toLowerCase()==="production")throw new Error("Demo fleet reset is disabled in production.");
    if(config.demo.enabled)throw new Error("Set DEMO_SIMULATION_ENABLED=false and stop the running backend before resetting the demo fleet.");
    const client=await pool.connect();
    try{
        await client.query("BEGIN");
        const active=await client.query(`SELECT COUNT(*)::int AS count FROM driver d WHERE d.is_demo=TRUE AND EXISTS(
          SELECT 1 FROM trip t WHERE (t.driver_id=d.driver_id OR t.vehicle_id IN(SELECT vehicle_id FROM vehicle WHERE driver_id=d.driver_id))
          AND t.trip_status IN ('DISPATCHED','IN_PROGRESS'))`);
        const result=await client.query(`UPDATE driver d SET is_online=FALSE,shift_status='OFFLINE'
          WHERE d.is_demo=TRUE AND NOT EXISTS(SELECT 1 FROM trip t WHERE (t.driver_id=d.driver_id OR t.vehicle_id IN
            (SELECT vehicle_id FROM vehicle v WHERE v.driver_id=d.driver_id)) AND t.trip_status IN ('DISPATCHED','IN_PROGRESS'))`);
        await client.query("COMMIT");
        console.log(`Marked ${result.rowCount} idle demo drivers offline. Preserved ${active.rows[0].count} drivers on active trips, all accounts, vehicles, bookings, and history.`);
    }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();await pool.end();}
}
reset().catch(error=>{console.error(error.message);process.exitCode=1;});

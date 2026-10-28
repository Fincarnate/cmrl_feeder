const pool=require("../db/pool");

async function inspect(){
    const {rows}=await pool.query(`SELECT d.full_name,d.email,d.current_service_mode,d.is_online,d.shift_status,
      d.location_recorded_at,d.location_accuracy_m,v.registration_no,v.max_capacity,v.is_active,v.is_frozen_until,
      EXISTS(SELECT 1 FROM trip t WHERE t.driver_id=d.driver_id AND t.trip_status IN ('DISPATCHED','IN_PROGRESS')) AS active_trip
      FROM driver d LEFT JOIN vehicle v ON v.driver_id=d.driver_id WHERE d.is_demo=TRUE ORDER BY d.current_service_mode,d.email`);
    const passengers=await pool.query("SELECT full_name,email FROM users WHERE is_demo=TRUE ORDER BY email");
    console.table(rows);
    console.log("Demo passenger accounts (passwords omitted):");console.table(passengers.rows);
}
inspect().catch(error=>{console.error(error.message);process.exitCode=1;}).finally(()=>pool.end());

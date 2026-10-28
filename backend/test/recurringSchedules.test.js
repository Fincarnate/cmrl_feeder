const test=require("node:test");
const assert=require("node:assert/strict");
const {addCalendarDay,departureDisposition,MISFIRE_GRACE_MS}=require("../src/modules/drt/services/scheduleService");

test("recurring schedule date advances across month, year, and leap-day boundaries",()=>{
    assert.equal(addCalendarDay("2026-01-31"),"2026-02-01");
    assert.equal(addCalendarDay("2026-12-31"),"2027-01-01");
    assert.equal(addCalendarDay("2028-02-28"),"2028-02-29");
    assert.equal(addCalendarDay("2028-02-29"),"2028-03-01");
});

test("recurring departure is created only when due and old missed departures are skipped",()=>{
    const departure=Date.parse("2026-10-29T03:30:00.000Z");
    assert.equal(departureDisposition(departure-1,departure),"NOT_DUE");
    assert.equal(departureDisposition(departure,departure),"DUE");
    assert.equal(departureDisposition(departure+MISFIRE_GRACE_MS,departure),"DUE");
    assert.equal(departureDisposition(departure+MISFIRE_GRACE_MS+1,departure),"MISSED");
});

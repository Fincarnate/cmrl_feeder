const test=require("node:test");
const assert=require("node:assert/strict");
const {isPeakAt,snapshotFor}=require("../src/modules/drt/services/operatingPolicy");

const policy={version:4,timezone:"Asia/Kolkata",operating_days:[1,2,3,4,5],peak_periods:[{start:"07:00",end:"10:00"},{start:"16:30",end:"20:30"}],peak_dispatch_wait_minutes:5,offpeak_dispatch_wait_minutes:8,peak_boarding_grace_minutes:2,offpeak_boarding_grace_minutes:4,otp_validity_minutes:5,otp_max_attempts:5,driver_location_max_age_seconds:90,minimum_dispatch_passengers:1,maximum_vehicle_capacity:8,dispatch_retry_minutes:1,dispatch_max_attempts:8};

test("morning and evening Kolkata peak windows and exact boundaries",()=>{
    assert.equal(isPeakAt("2026-01-05T01:30:00Z",policy),true);
    assert.equal(isPeakAt("2026-01-05T04:30:00Z",policy),false);
    assert.equal(isPeakAt("2026-01-05T11:00:00Z",policy),true);
    assert.equal(isPeakAt("2026-01-05T15:00:00Z",policy),false);
});

test("weekends use configured operating days",()=>{
    assert.equal(isPeakAt("2026-01-10T01:30:00Z",policy),false);
});

test("cross-midnight windows honor the day on which the window started",()=>{
    const overnight={...policy,timezone:"UTC",operating_days:[1],peak_periods:[{start:"23:00",end:"01:00"}]};
    assert.equal(isPeakAt("2026-01-06T00:30:00Z",overnight),true);
    assert.equal(isPeakAt("2026-01-06T01:00:00Z",overnight),false);
});

test("timer snapshot freezes dispatch and boarding timing",()=>{
    const snapshot=snapshotFor("2026-01-05T01:30:00Z",policy);
    assert.equal(snapshot.period,"PEAK");
    assert.equal(snapshot.dispatchWaitMinutes,5);
    assert.equal(snapshot.boardingGraceMinutes,2);
    assert.equal(snapshot.otpValidityMinutes,5);
    assert.equal(snapshot.version,4);
});

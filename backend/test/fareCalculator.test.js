const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateFare, straightLineDistanceKm } = require("../src/modules/drt/services/fareCalculator");

const policy={version:3,currency:"INR",base_fare:"10.00",per_km_rate:"1.01",minimum_fare:"9.00",booking_fee:"0.00",peak_multiplier:"1.0000",offpeak_multiplier:"1.0000",direction_rates:{}};

test("fare uses integer minor units and rounds distance charge consistently",()=>{
    const fare=calculateFare({distanceKm:1.235,policy,direction:"RESIDENTIAL_TO_METRO",isPeak:false});
    assert.equal(fare.breakdown.distanceFare,"1.25");
    assert.equal(fare.fare,"11.25");
    assert.equal(fare.distanceType,"ESTIMATED");
});

test("minimum fare is applied after fees and multiplier",()=>{
    const fare=calculateFare({distanceKm:.1,policy:{...policy,minimum_fare:"25.00"},direction:"METRO_TO_RESIDENTIAL",isPeak:false});
    assert.equal(fare.fare,"25.00");
    assert.equal(fare.breakdown.minimumFareApplied,true);
});

test("peak multiplier applies only when policy says peak",()=>{
    const configured={...policy,peak_multiplier:"1.5000"};
    assert.equal(calculateFare({distanceKm:2,policy:configured,direction:"RESIDENTIAL_TO_METRO",isPeak:true}).fare,"18.03");
    assert.equal(calculateFare({distanceKm:2,policy:configured,direction:"RESIDENTIAL_TO_METRO",isPeak:false}).fare,"12.02");
});

test("direction-specific rates and frozen policy version are reflected",()=>{
    const fare=calculateFare({distanceKm:1,policy:{...policy,direction_rates:{METRO_TO_RESIDENTIAL:{base_fare:"30.00",per_km_rate:"2.00"}}},direction:"METRO_TO_RESIDENTIAL",isPeak:false});
    assert.equal(fare.fare,"32.00"); assert.equal(fare.policyVersion,3);
});

test("invalid negative rates, multipliers, and distances are rejected",()=>{
    assert.throws(()=>calculateFare({distanceKm:-1,policy,direction:"R",isPeak:false}));
    assert.throws(()=>calculateFare({distanceKm:1,policy:{...policy,per_km_rate:"-1"},direction:"R",isPeak:false}));
    assert.throws(()=>calculateFare({distanceKm:1,policy:{...policy,peak_multiplier:"0"},direction:"R",isPeak:true}));
});

test("geographic fallback returns a positive straight-line estimate",()=>{
    assert.ok(straightLineDistanceKm({latitude:13,longitude:80},{latitude:13.01,longitude:80.01})>0);
});

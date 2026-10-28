const test=require("node:test");
const assert=require("node:assert/strict");
const {validateDemoConfig}=require("../src/modules/drt/services/demoFleetService");
const config=require("../src/config/env");
const {validateSeedConfig}=require("../src/scripts/seed-demo-fleet");

const valid={enabled:true,m2rAvailableTarget:3,r2mAvailableTarget:3,driverPoolSizePerDirection:6,
    locationUpdateIntervalMs:5000,ghostPassengerIntervalSeconds:60,maxActiveGhostBookings:6};

test("demo simulator requires explicit opt-in and rejects production",()=>{
    assert.doesNotThrow(()=>validateDemoConfig({...valid,enabled:false},"production"));
    assert.throws(()=>validateDemoConfig(valid,"production"),/forbidden.*production/i);
});

test("demo pool must be large enough for each direction target",()=>{
    assert.doesNotThrow(()=>validateDemoConfig(valid,"development"));
    assert.throws(()=>validateDemoConfig({...valid,driverPoolSizePerDirection:2},"development"),/between each available target/i);
});

test("demo intervals and target settings are bounded",()=>{
    assert.throws(()=>validateDemoConfig({...valid,locationUpdateIntervalMs:100},"development"),/DEMO_DRIVER_LOCATION_UPDATE_INTERVAL_MS/i);
    assert.throws(()=>validateDemoConfig({...valid,m2rAvailableTarget:0},"development"),/DEMO_M2R_AVAILABLE_TARGET/i);
    assert.throws(()=>validateDemoConfig({...valid,maxActiveGhostBookings:51},"development"),/DEMO_MAX_ACTIVE_GHOST_BOOKINGS/i);
});

test("demo seeding requires a local password and refuses production",()=>{
    const originalPassword=config.demo.accountPassword,originalEnvironment=config.demo.nodeEnv;
    try{
        config.demo.accountPassword="";
        assert.throws(()=>validateSeedConfig(),/DEMO_ACCOUNT_PASSWORD/i);
        config.demo.accountPassword="local-test-password";
        config.demo.nodeEnv="Production";
        assert.throws(()=>validateSeedConfig(),/disabled in production/i);
    }finally{config.demo.accountPassword=originalPassword;config.demo.nodeEnv=originalEnvironment;}
});

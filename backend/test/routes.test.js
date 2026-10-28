process.env.JWT_SECRET ||= "cmrl-feeder-route-tests-only-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const buildApp = require("../src/app");
const { generateToken } = require("../src/utils/jwt");

test("protected DRT routes reject missing credentials and wrong roles", async t => {
    const app = buildApp();
    t.after(() => app.close());
    await app.ready();

    const missing = await app.inject({ method: "GET", url: "/api/bookings" });
    assert.equal(missing.statusCode, 401);

    const passengerToken = generateToken({ id: "11111111-1111-4111-8111-111111111111", email: "test@example.invalid", role: "PASSENGER" });
    const wrongRole = await app.inject({ method: "GET", url: "/api/dashboard/policies", headers: { authorization: `Bearer ${passengerToken}` } });
    assert.equal(wrongRole.statusCode, 403);
    const demoWrongRole = await app.inject({ method: "GET", url: "/api/dashboard/demo-fleet", headers: { authorization: `Bearer ${passengerToken}` } });
    assert.equal(demoWrongRole.statusCode, 403);

    const invalidRequest = await app.inject({ method: "POST", url: "/api/bookings/fare-preview", headers: { authorization: `Bearer ${passengerToken}` }, payload: {} });
    assert.equal(invalidRequest.statusCode, 400);
});

test("driver telemetry validates coordinates before database access", async t => {
    const app = buildApp();
    t.after(() => app.close());
    await app.ready();
    const driverToken = generateToken({ id: "22222222-2222-4222-8222-222222222222", email: "driver@example.invalid", role: "DRIVER" });
    const response = await app.inject({
        method: "POST", url: "/api/drivers/telemetry",
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { latitude: 91, longitude: 0 }
    });
    assert.equal(response.statusCode, 400);
});

test("driver workflow endpoints are protected and validate mode before database access",async t=>{
    const app=buildApp();t.after(()=>app.close());await app.ready();
    const missing=await app.inject({method:"GET",url:"/api/drivers/service-mode"});assert.equal(missing.statusCode,401);
    const token=generateToken({id:"22222222-2222-4222-8222-222222222222",email:"driver@example.invalid",role:"DRIVER"});
    const invalid=await app.inject({method:"POST",url:"/api/drivers/service-mode",headers:{authorization:`Bearer ${token}`},payload:{mode:"ANYWHERE"}});assert.equal(invalid.statusCode,400);
    const zone=await app.inject({method:"POST",url:"/api/drivers/active-zone",headers:{authorization:`Bearer ${token}`},payload:{zoneId:"bad"}});assert.equal(zone.statusCode,400);
});

test("recurring schedule read, create, and cancel routes require passenger authentication",async t=>{
    const app=buildApp();t.after(()=>app.close());await app.ready();
    for(const [method,url] of [["GET","/api/bookings/schedules"],["POST","/api/bookings/schedules"],["POST","/api/bookings/schedules/11111111-1111-4111-8111-111111111111/cancel"]]){
        const response=await app.inject({method,url});
        assert.equal(response.statusCode,401,`${method} ${url}`);
    }
});

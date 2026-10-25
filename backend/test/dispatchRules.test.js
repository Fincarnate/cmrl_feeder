const test=require("node:test");
const assert=require("node:assert/strict");
const {isCompatible,fifo,dispatchDecision}=require("../src/modules/drt/services/dispatchRules");

test("dispatches immediately at capacity and partially after deadline",()=>{
    assert.equal(dispatchDecision({passengerCount:4,occupiedSeats:4,capacity:4,deadlineExpired:false}),"DISPATCH_FULL");
    assert.equal(dispatchDecision({passengerCount:2,occupiedSeats:2,capacity:4,deadlineExpired:true}),"DISPATCH_PARTIAL");
});

test("does not dispatch empty or below-minimum trips",()=>{
    assert.equal(dispatchDecision({passengerCount:0,occupiedSeats:0,capacity:4,deadlineExpired:true}),"EMPTY");
    assert.equal(dispatchDecision({passengerCount:1,occupiedSeats:1,capacity:4,deadlineExpired:true,minimumPassengers:2}),"MINIMUM_NOT_MET");
});

test("matching requires direction, station, and zone compatibility",()=>{
    const a={direction:"METRO_TO_RESIDENTIAL",stationId:"s1",zoneId:"z1"};
    assert.equal(isCompatible(a,{...a}),true);
    assert.equal(isCompatible(a,{...a,stationId:"s2"}),false);
    assert.equal(isCompatible(a,{...a,zoneId:"z2"}),false);
    assert.equal(isCompatible(a,{...a,direction:"RESIDENTIAL_TO_METRO"}),false);
});

test("eligible requests retain FIFO creation order",()=>{
    const items=[{id:"b",requestedAt:"2026-01-02"},{id:"a",requestedAt:"2026-01-01"}];
    assert.deepEqual(fifo(items).map(item=>item.id),["a","b"]);
});

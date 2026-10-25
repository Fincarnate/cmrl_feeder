const test=require("node:test");
const assert=require("node:assert/strict");
const {orderNearestNeighbor}=require("../src/modules/drt/services/dispatchService");

test("residential route preview ordering is nearest-next and stable for ties",()=>{
    const start={latitude:13.08,longitude:80.20};
    const points=[
        {point_id:"b",latitude:13.082,longitude:80.20},
        {point_id:"a",latitude:13.082,longitude:80.20},
        {point_id:"c",latitude:13.09,longitude:80.20}
    ];
    assert.deepEqual(orderNearestNeighbor(points,start).map(p=>p.point_id),["a","b","c"]);
    assert.deepEqual(orderNearestNeighbor([],start),[]);
});

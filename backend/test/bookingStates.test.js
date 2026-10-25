const test = require("node:test");
const assert = require("node:assert/strict");
const { canTransition, assertTransition } = require("../src/modules/drt/services/bookingStates");

test("booking lifecycle allows only defined forward transitions", () => {
    assert.equal(canTransition("REQUESTED", "ASSIGNED"), true);
    assert.equal(canTransition("BOARDING", "NO_SHOW"), true);
    assert.equal(canTransition("IN_PROGRESS", "CANCELLED"), false);
    assert.equal(canTransition("COMPLETED", "CANCELLED"), false);
    assert.throws(() => assertTransition("COMPLETED", "CANCELLED"), { statusCode: 409 });
});

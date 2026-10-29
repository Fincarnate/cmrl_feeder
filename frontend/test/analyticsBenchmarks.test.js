import test from "node:test";
import assert from "node:assert/strict";
import { validateBenchmarks, compareScenario } from "../src/analytics/benchmarks.js";

const valid = {
    petrolPrice: "102.5", fuelEfficiency: "15", parkingPrice: "30", parkingHours: "2",
    distanceMode: "multiplier", roadDistanceMultiplier: "1.25", actualRoadDistance: "",
    rushTravelMinutes: "42", offpeakTravelMinutes: "28"
};

test("benchmarks reject invalid petrol, zero mileage, and negative parking inputs", () => {
    assert.match(validateBenchmarks({ ...valid, petrolPrice: "-1" }), /petrol price/i);
    assert.match(validateBenchmarks({ ...valid, petrolPrice: "NaN" }), /petrol price/i);
    assert.match(validateBenchmarks({ ...valid, fuelEfficiency: "0" }), /efficiency/i);
    assert.match(validateBenchmarks({ ...valid, parkingPrice: "-0.01" }), /parking price/i);
    assert.match(validateBenchmarks({ ...valid, parkingHours: "-1" }), /parking duration/i);
});

test("benchmarks accept valid zero parking and calculate entered fuel and parking costs", () => {
    assert.equal(validateBenchmarks({ ...valid, parkingHours: "0", parkingPrice: "0" }), "");
    const result = compareScenario(
        { scenario: { distanceKm: 10, period: "PEAK" } },
        valid,
        { fare: { available: true, value: 70 }, duration: { available: true, value: 35 } }
    );
    assert.equal(result.roadDistanceKm, 12.5);
    assert.equal(result.fuelCost, 85.41666666666667);
    assert.equal(result.parkingCost, 60);
    assert.equal(result.privateCost, result.fuelCost + result.parkingCost);
    assert.equal(result.privateMinutes, 42);
    assert.equal(result.costResult, "CMRL is cheaper");
    assert.equal(result.timeResult, "CMRL is faster");
});

test("actual road distance overrides the multiplier and cost comparison remains neutral", () => {
    const benchmarks = { ...valid, distanceMode: "actual", actualRoadDistance: "8" };
    const result = compareScenario(
        { scenario: { distanceKm: 10, period: "OFFPEAK" } },
        benchmarks,
        { fare: { available: true, value: 1000 }, duration: { available: true, value: 40 } }
    );
    assert.equal(result.roadDistanceKm, 8);
    assert.equal(result.privateMinutes, 28);
    assert.equal(result.costResult, "Private vehicle is cheaper");
    assert.equal(result.timeResult, "Private vehicle is faster");
});

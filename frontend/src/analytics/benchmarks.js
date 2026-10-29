export function numberOrNull(value) {
    if (value === "" || value === null || value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

export function validateBenchmarks(value) {
    const petrol = numberOrNull(value.petrolPrice);
    const efficiency = numberOrNull(value.fuelEfficiency);
    const parking = numberOrNull(value.parkingPrice);
    const parkingHours = numberOrNull(value.parkingHours);
    const rushMinutes = numberOrNull(value.rushTravelMinutes);
    const offpeakMinutes = numberOrNull(value.offpeakTravelMinutes);
    if (petrol === null || petrol < 0) return "Enter a non-negative petrol price.";
    if (efficiency === null || efficiency <= 0) return "Fuel efficiency must be greater than zero.";
    if (parking === null || parking < 0) return "Enter a non-negative parking price.";
    if (parkingHours === null || parkingHours < 0) return "Parking duration cannot be negative.";
    if (rushMinutes === null || rushMinutes <= 0 || offpeakMinutes === null || offpeakMinutes <= 0)
        return "Enter positive private-vehicle travel times for rush hour and off-peak.";
    if (value.distanceMode === "actual") {
        const actual = numberOrNull(value.actualRoadDistance);
        if (actual === null || actual <= 0) return "Enter a positive actual road distance.";
    } else {
        const multiplier = numberOrNull(value.roadDistanceMultiplier);
        if (multiplier === null || multiplier < 1 || multiplier > 5) return "Road-distance multiplier must be from 1 to 5.";
    }
    return "";
}

export function compareScenario(result, benchmarks, prediction) {
    if (!result?.scenario || validateBenchmarks(benchmarks)) return null;
    const roadDistanceKm = benchmarks.distanceMode === "actual"
        ? Number(benchmarks.actualRoadDistance)
        : result.scenario.distanceKm * Number(benchmarks.roadDistanceMultiplier);
    const fuelCost = roadDistanceKm / Number(benchmarks.fuelEfficiency) * Number(benchmarks.petrolPrice);
    const parkingCost = Number(benchmarks.parkingPrice) * Number(benchmarks.parkingHours);
    const privateCost = fuelCost + parkingCost;
    const privateMinutes = result.scenario.period === "PEAK"
        ? Number(benchmarks.rushTravelMinutes) : Number(benchmarks.offpeakTravelMinutes);
    const fare = prediction?.fare?.available ? prediction.fare.value : null;
    const duration = prediction?.duration?.available ? prediction.duration.value : null;
    return {
        roadDistanceKm,
        fuelCost,
        parkingCost,
        privateCost,
        privateMinutes,
        fare,
        duration,
        absoluteCostDifference: fare === null ? null : Math.abs(fare - privateCost),
        percentCostDifference: fare === null || privateCost <= 0 ? null : Math.abs(fare - privateCost) / privateCost * 100,
        costResult: fare === null ? null : fare < privateCost ? "CMRL is cheaper" : fare > privateCost ? "Private vehicle is cheaper" : "Estimated costs are equal",
        absoluteTimeDifference: duration === null ? null : Math.abs(duration - privateMinutes),
        timeResult: duration === null ? null : duration < privateMinutes ? "CMRL is faster" : duration > privateMinutes ? "Private vehicle is faster" : "Estimated times are equal"
    };
}

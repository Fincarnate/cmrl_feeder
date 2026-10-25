function isCompatible(a, b) {
    return a.direction === b.direction && a.stationId === b.stationId && a.zoneId === b.zoneId;
}

function fifo(items) { return [...items].sort((a,b) => new Date(a.requestedAt)-new Date(b.requestedAt)); }

function dispatchDecision({ passengerCount, occupiedSeats, capacity, deadlineExpired, minimumPassengers = 1 }) {
    if (passengerCount <= 0 || occupiedSeats <= 0) return "EMPTY";
    if (occupiedSeats > capacity) return "OVER_CAPACITY";
    if (occupiedSeats === capacity) return "DISPATCH_FULL";
    if (deadlineExpired && passengerCount >= minimumPassengers) return "DISPATCH_PARTIAL";
    if (deadlineExpired) return "MINIMUM_NOT_MET";
    return "WAIT";
}

module.exports = { isCompatible, fifo, dispatchDecision };

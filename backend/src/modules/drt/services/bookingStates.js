const transitions = {
    REQUESTED: ["ASSIGNED", "CANCELLED", "FAILED"],
    ASSIGNED: ["BOARDING", "CANCELLED", "FAILED"],
    BOARDING: ["IN_PROGRESS", "NO_SHOW", "CANCELLED"],
    IN_PROGRESS: ["COMPLETED"],
    COMPLETED: [], CANCELLED: [], NO_SHOW: [], FAILED: []
};

function canTransition(from, to) { return (transitions[from] || []).includes(to); }

function assertTransition(from, to) {
    if (!canTransition(from, to)) throw Object.assign(new Error(`Booking cannot transition from ${from} to ${to}.`), { statusCode: 409 });
}

module.exports = { canTransition, assertTransition, transitions };

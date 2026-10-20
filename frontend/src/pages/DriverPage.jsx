import { useState } from "react";
import { apiRequest } from "../api";

function DriverPage() {
    const [token, setToken] = useState("");
    const [mode, setMode] = useState("WAITING");
    const [bookingId, setBookingId] = useState("");
    const [otp, setOtp] = useState("");
    const [tripId, setTripId] = useState("");

    const [result, setResult] = useState(null);
    const [message, setMessage] = useState("");
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);

    function resetMessages() {
        setResult(null);
        setMessage("");
        setError("");
    }

    async function performAction(action, successMessage) {
        resetMessages();

        if (!token.trim()) {
            setError("Enter a driver JWT before using this action.");
            return;
        }

        setLoading(true);

        try {
            const data = await action(token.trim());
            setResult(data);
            setMessage(successMessage);
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }

    function loadProfile() {
        return performAction(
            (jwt) =>
                apiRequest("/api/drivers/me", { method: "GET" }, jwt),
            "Driver profile retrieved."
        );
    }

    function updateMode(event) {
        event.preventDefault();

        return performAction(
            (jwt) =>
                apiRequest(
                    "/api/drivers/me/mode",
                    {
                        method: "PATCH",
                        body: JSON.stringify({ mode }),
                    },
                    jwt
                ),
            `Driver mode updated to ${mode}.`
        );
    }

    function validatePassenger(event) {
        event.preventDefault();

        if (!bookingId.trim() || !otp.trim()) {
            setError("Enter both a booking ID and OTP.");
            return;
        }

        return performAction(
            (jwt) =>
                apiRequest(
                    "/api/drivers/me/validate-passenger",
                    {
                        method: "POST",
                        body: JSON.stringify({
                            bookingId: bookingId.trim(),
                            otp: otp.trim(),
                        }),
                    },
                    jwt
                ),
            "Passenger validation request completed."
        );
    }

    function terminateService(event) {
        event.preventDefault();

        if (!tripId.trim()) {
            setError("Enter a trip ID.");
            return;
        }

        return performAction(
            (jwt) =>
                apiRequest(
                    "/api/drivers/me/terminate-service",
                    {
                        method: "POST",
                        body: JSON.stringify({ tripId: tripId.trim() }),
                    },
                    jwt
                ),
            "Service termination request completed."
        );
    }

    return (
        <main className="dashboard-page">
            <section className="dashboard-card">
                <header className="dashboard-header">
                    <div>
                        <h1>Driver Portal</h1>
                        <p>CMRL Feeder driver controls</p>
                    </div>
                    <a href="/passenger">Passenger page →</a>
                </header>

                <section className="form-section">
                    <h2>Driver API token</h2>
                    <label htmlFor="driver-token">Driver JWT</label>
                    <input
                        id="driver-token"
                        type="password"
                        value={token}
                        onChange={(event) => setToken(event.target.value)}
                        placeholder="Paste driver token"
                    />
                    <p className="helper-text">
                        Protected endpoints require a driver token. Driver
                        token issuance will be implemented separately.
                    </p>
                </section>

                <section className="form-section">
                    <h2>1. Driver profile</h2>
                    <button
                        type="button"
                        onClick={loadProfile}
                        disabled={loading}
                    >
                        Get my profile
                    </button>
                </section>

                <form onSubmit={updateMode} className="form-section">
                    <h2>2. Change service mode</h2>

                    <label htmlFor="driver-mode">Current desired mode</label>
                    <select
                        id="driver-mode"
                        value={mode}
                        onChange={(event) => setMode(event.target.value)}
                    >
                        <option value="WAITING">
                            Metro to residential — waiting
                        </option>
                        <option value="PICKUP">
                            Residential to metro — pickup
                        </option>
                    </select>

                    <button type="submit" disabled={loading}>
                        Update mode
                    </button>
                </form>

                <form onSubmit={validatePassenger} className="form-section">
                    <h2>3. Validate passenger</h2>

                    <label htmlFor="booking-id">Booking ID</label>
                    <input
                        id="booking-id"
                        value={bookingId}
                        onChange={(event) => setBookingId(event.target.value)}
                        placeholder="Booking UUID"
                        required
                    />

                    <label htmlFor="passenger-otp">Passenger OTP</label>
                    <input
                        id="passenger-otp"
                        value={otp}
                        onChange={(event) => setOtp(event.target.value)}
                        placeholder="Enter OTP"
                        required
                    />

                    <button type="submit" disabled={loading}>
                        Validate passenger
                    </button>
                </form>

                <form onSubmit={terminateService} className="form-section">
                    <h2>4. Terminate service</h2>

                    <label htmlFor="trip-id">Trip ID</label>
                    <input
                        id="trip-id"
                        value={tripId}
                        onChange={(event) => setTripId(event.target.value)}
                        placeholder="Trip UUID"
                        required
                    />

                    <button type="submit" disabled={loading}>
                        Terminate service
                    </button>
                </form>

                {message && <p className="status-success">{message}</p>}
                {error && <p className="status-error">{error}</p>}

                {result && (
                    <section className="form-section">
                        <h2>API response</h2>
                        <pre className="response-output">
                            {JSON.stringify(result, null, 2)}
                        </pre>
                    </section>
                )}
            </section>
        </main>
    );
}

export default DriverPage;
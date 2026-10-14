import { useEffect, useState } from "react";

function DashboardPage({ token, admin, onLogout }) {
    const [summary, setSummary] = useState(null);
    const [error, setError] = useState("");

    useEffect(() => {
        async function loadSummary() {
            try {
                const response = await fetch(
                    "http://localhost:5000/api/dashboard/summary",
                    {
                        headers: {
                            Authorization: `Bearer ${token}`
                        }
                    }
                );

                const data = await response.json();

                if (response.status === 401 || response.status === 403) {
                    onLogout();
                    return;
                }

                if (!response.ok) {
                    setError(data.message || "Unable to load dashboard data.");
                    return;
                }

                setSummary(data);
            } catch {
                setError("Unable to reach the server. Please try again later.");
            }
        }

        loadSummary();
    }, [token, onLogout]);

    return (
        <main className="dashboard-page">
            <section className="dashboard-card">
                <div className="dashboard-header">
                    <div>
                        <h1>CMRL Feeder</h1>
                        <p>Admin Dashboard — {admin.name}</p>
                    </div>
                    <button type="button" onClick={onLogout}>
                        Log out
                    </button>
                </div>

                {error ? <p className="login-error" role="alert">{error}</p> : null}

                {!summary && !error ? <p>Loading dashboard data...</p> : null}

                {summary ? (
                    <div className="dashboard-stats">
                        <p>
                            Available drivers: <strong>{summary.availableDrivers}</strong>
                        </p>
                        <p>
                            Total passengers: <strong>{summary.totalPassengers}</strong>
                        </p>
                    </div>
                ) : null}
            </section>
        </main>
    );
}

export default DashboardPage;

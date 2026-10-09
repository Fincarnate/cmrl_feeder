import { useState } from "react";

function LoginPage() {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [admin, setAdmin] = useState(null);

    async function handleSubmit(event) {
        event.preventDefault();
        setError("");
        setIsSubmitting(true);

        try {
            const response = await fetch("http://localhost:5000/api/auth/login", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ email, password })
            });

            const data = await response.json();

            if (!response.ok) {
                setError(data.message || "Unable to log in. Please try again.");
                return;
            }

            localStorage.setItem("authToken", data.token);
            localStorage.setItem("admin", JSON.stringify(data.admin));
            setAdmin(data.admin);
            setPassword("");
        } catch {
            setError("Unable to reach the server. Please try again later.");
        } finally {
            setIsSubmitting(false);
        }
    }

    return (
        <main className="login-page">
            <section className="login-card">
                <h1>CMRL Feeder</h1>
                <p>Admin Dashboard Login</p>

                {admin ? (
                    <div className="login-success" role="status">
                        Logged in as {admin.name}.
                    </div>
                ) : null}

                <form onSubmit={handleSubmit}>
                    <label htmlFor="email">Email</label>
                    <input
                        id="email"
                        type="email"
                        value={email}
                        onChange={(event) =>
                            setEmail(event.target.value)
                        }
                        placeholder="Enter your admin email"
                        required
                        disabled={isSubmitting || Boolean(admin)}
                    />

                    <label htmlFor="password">Password</label>
                    <input
                        id="password"
                        type="password"
                        value={password}
                        onChange={(event) =>
                            setPassword(event.target.value)
                        }
                        placeholder="Enter your password"
                        required
                        disabled={isSubmitting || Boolean(admin)}
                    />

                    {error ? (
                        <p className="login-error" role="alert">
                            {error}
                        </p>
                    ) : null}

                    <button type="submit" disabled={isSubmitting || Boolean(admin)}>
                        {isSubmitting ? "Logging in..." : "Login"}
                    </button>
                </form>
            </section>
        </main>
    );
}

export default LoginPage;

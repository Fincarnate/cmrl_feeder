import { useState } from "react";
import { apiRequest } from "../api/client";
import FormField from "../components/FormField";

function LoginPage({ onAuthenticated }) {
    const [mode, setMode] = useState("login");
    const [role, setRole] = useState("PASSENGER");
    const [values, setValues] = useState({ name: "", email: "", phone: "", password: "", confirmPassword: "", licenseNumber: "", vehicleRegistration: "", vehicleCapacity: "" });
    const [errors, setErrors] = useState({});
    const [error, setError] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);

    async function handleSubmit(event) {
        event.preventDefault();
        setError("");
        const nextErrors = {};
        if (mode === "register") {
            if (!values.name.trim()) nextErrors.name = "Enter your name.";
            if (!/^\+?[0-9]{10,15}$/.test(values.phone.trim())) nextErrors.phone = "Enter a phone number with 10 to 15 digits.";
            if (values.password.length < 8) nextErrors.password = "Use at least 8 characters.";
            if (values.password !== values.confirmPassword) nextErrors.confirmPassword = "Passwords do not match.";
            if (role === "DRIVER" && !values.licenseNumber.trim()) nextErrors.licenseNumber = "Enter your driving license number.";
            if (role === "DRIVER" && !values.vehicleRegistration.trim()) nextErrors.vehicleRegistration = "Enter your vehicle registration.";
            if (role === "DRIVER" && (!Number.isInteger(Number(values.vehicleCapacity)) || Number(values.vehicleCapacity) < 1 || Number(values.vehicleCapacity) > 99)) nextErrors.vehicleCapacity = "Enter the vehicle's passenger capacity (1–99).";
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim())) nextErrors.email = "Enter a valid email address.";
        setErrors(nextErrors);
        if (Object.keys(nextErrors).length) return;
        setIsSubmitting(true);

        try {
            const data = await apiRequest(mode === "login" ? "/auth/login" : "/auth/register", {
                method: "POST",
                body: JSON.stringify(mode === "login" ? { email: values.email, password: values.password } : {
                    role, name: values.name, email: values.email, phone: values.phone, password: values.password,
                    ...(role === "DRIVER" ? { licenseNumber: values.licenseNumber, vehicleRegistration: values.vehicleRegistration, vehicleCapacity: Number(values.vehicleCapacity) } : {})
                })
            });
            onAuthenticated({ token: data.token, identity: data.identity });
        } catch (requestError) {
            setError(requestError.message || "Unable to reach the server. Please try again later.");
        } finally {
            setIsSubmitting(false);
        }
    }

    return (
        <main className="login-page">
            <section className="login-card">
                <h1>CMRL Feeder</h1>
                <p>{mode === "login" ? "Sign in to your account" : "Create a Passenger or Driver account"}</p>

                <div className="auth-switch" role="tablist" aria-label="Authentication mode">
                    <button type="button" className={mode === "login" ? "selected" : ""} onClick={() => { setMode("login"); setError(""); }}>Login</button>
                    <button type="button" className={mode === "register" ? "selected" : ""} onClick={() => { setMode("register"); setError(""); }}>Register</button>
                </div>

                <form onSubmit={handleSubmit}>
                    {mode === "register" && <>
                        <div className="role-choice"><span>Account type</span><label><input type="radio" name="role" value="PASSENGER" checked={role === "PASSENGER"} onChange={() => setRole("PASSENGER")} /> Passenger</label><label><input type="radio" name="role" value="DRIVER" checked={role === "DRIVER"} onChange={() => setRole("DRIVER")} /> Driver</label></div>
                        <FormField id="name" label="Full name" value={values.name} onChange={e => setValues({ ...values, name: e.target.value })} error={errors.name} disabled={isSubmitting} autoComplete="name" />
                    </>}
                    <FormField id="email" label="Email" type="email" autoComplete="email" value={values.email} onChange={e => setValues({ ...values, email: e.target.value })} error={errors.email} disabled={isSubmitting} />
                    {mode === "register" && <FormField id="phone" label="Phone number" type="tel" autoComplete="tel" value={values.phone} onChange={e => setValues({ ...values, phone: e.target.value })} error={errors.phone} disabled={isSubmitting} />}
                    {mode === "register" && role === "DRIVER" && <>
                        <FormField id="licenseNumber" label="Driving license number" value={values.licenseNumber} onChange={e => setValues({ ...values, licenseNumber: e.target.value })} error={errors.licenseNumber} disabled={isSubmitting} />
                        <FormField id="vehicleRegistration" label="Vehicle registration" value={values.vehicleRegistration} onChange={e => setValues({ ...values, vehicleRegistration: e.target.value })} error={errors.vehicleRegistration} disabled={isSubmitting} />
                        <FormField id="vehicleCapacity" label="Vehicle passenger capacity" type="number" min="1" max="99" step="1" value={values.vehicleCapacity} onChange={e => setValues({ ...values, vehicleCapacity: e.target.value })} error={errors.vehicleCapacity} disabled={isSubmitting} />
                    </>}
                    <FormField id="password" label="Password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} value={values.password} onChange={e => setValues({ ...values, password: e.target.value })} error={errors.password} disabled={isSubmitting} />
                    {mode === "register" && <FormField id="confirmPassword" label="Confirm password" type="password" autoComplete="new-password" value={values.confirmPassword} onChange={e => setValues({ ...values, confirmPassword: e.target.value })} error={errors.confirmPassword} disabled={isSubmitting} />}

                    {error ? (
                        <p className="login-error" role="alert">
                            {error}
                        </p>
                    ) : null}

                    <button type="submit" disabled={isSubmitting}>
                        {isSubmitting ? "Please wait…" : mode === "login" ? "Login" : "Create account"}
                    </button>
                </form>
            </section>
        </main>
    );
}

export default LoginPage;

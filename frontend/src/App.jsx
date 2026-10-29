import { useCallback, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from "react-router-dom";
import LoginPage from "./pages/LoginPage";
import DashboardPage from "./pages/DashboardPage";
import PassengerPage from "./pages/PassengerPage";
import DriverPage from "./pages/DriverPage";
import DataAnalyticsPage from "./pages/DataAnalyticsPage";

function destination(identity) {
    return identity?.role === "ADMIN" ? "/admin" : identity?.role === "DRIVER" ? "/driver" : "/passenger";
}

function AuthRoutes() {
    const [session, setSession] = useState(() => {
        try { return JSON.parse(sessionStorage.getItem("cmrlSession")) || null; } catch { return null; }
    });
    const navigate = useNavigate();
    function login(next) {
        sessionStorage.setItem("cmrlSession", JSON.stringify(next));
        setSession(next);
        navigate(destination(next.identity), { replace: true });
    }
    const logout = useCallback(() => {
        sessionStorage.removeItem("cmrlSession");
        setSession(null);
        navigate("/login", { replace: true });
    }, [navigate]);
    const protectedPage = (role) => session?.identity?.role === role
        ? role === "ADMIN" ? <DashboardPage session={session} onLogout={logout} /> : role === "DRIVER" ? <DriverPage session={session} onLogout={logout} /> : <PassengerPage session={session} onLogout={logout} />
        : session ? <Navigate to={destination(session.identity)} replace /> : <Navigate to="/login" replace />;
    return <Routes>
        <Route path="/" element={<Navigate to={session ? destination(session.identity) : "/login"} replace />} />
        <Route path="/login" element={session ? <Navigate to={destination(session.identity)} replace /> : <LoginPage onAuthenticated={login} />} />
        <Route path="/admin" element={protectedPage("ADMIN")} />
        <Route path="/admin/analytics" element={session?.identity?.role === "ADMIN"
            ? <DataAnalyticsPage session={session} onLogout={logout} />
            : session ? <Navigate to={destination(session.identity)} replace /> : <Navigate to="/login" replace />} />
        <Route path="/passenger" element={protectedPage("PASSENGER")} />
        <Route path="/driver" element={protectedPage("DRIVER")} />
        <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>;
}

function App() {
    return (
        <BrowserRouter><AuthRoutes /></BrowserRouter>
    );
}

export default App;

import { useState } from 'react'
import './App.css'

function App() {
  const [loggedIn, setLoggedIn] = useState(false)
  const [driverId, setDriverId] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [available, setAvailable] = useState(true)

  const driver = {
    name: 'Driver',
    id: driverId,
    vehicle: 'Assigned Vehicle',
    area: 'Chennai',
  }

  function handleLogin(e) {
    e.preventDefault()

    if (!driverId.trim() || !password.trim()) {
      setError('Please enter your Driver ID and password.')
      return
    }

    setError('')
    setLoggedIn(true)
  }

  if (!loggedIn) {
    return (
      <main className="login-page">
        <section className="login-card">
          <div className="brand-icon">M</div>
          <p className="eyebrow">CHENNAI METRO RAIL</p>
          <h1>Driver Portal</h1>
          <p className="subtitle">Welcome back. Sign in to continue.</p>

          <form onSubmit={handleLogin}>
            <label htmlFor="driverId">Driver ID</label>
            <input
              id="driverId"
              value={driverId}
              onChange={(e) => setDriverId(e.target.value)}
              placeholder="Enter your Driver ID"
            />

            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
            />

            {error && <p className="error">{error}</p>}

            <button className="primary-btn" type="submit">
              Sign In →
            </button>
          </form>

          <p className="footer-note">CMRL Feeder Transportation System</p>
        </section>
      </main>
    )
  }

  return (
    <main className="dashboard">
      <header className="topbar">
        <div className="brand">
          <span className="brand-icon small">M</span>
          <div>
            <strong>CMRL Feeder</strong>
            <small>Driver Portal</small>
          </div>
        </div>
        <button className="logout-btn" onClick={() => setLoggedIn(false)}>
          Log out
        </button>
      </header>

      <section className="welcome">
        <p className="eyebrow">DRIVER WORKSPACE</p>
        <h1>Welcome, {driver.name} 👋</h1>
        <p>Manage your availability and view your driver information.</p>
      </section>

      <section className="status-card">
        <div>
          <span className={`status-dot ${available ? '' : 'offline'}`}></span>
          <strong>{available ? 'Available for trips' : 'Currently unavailable'}</strong>
          <p>Update your status when you're ready.</p>
        </div>
        <button
          className={`toggle-btn ${available ? 'active' : ''}`}
          onClick={() => setAvailable(!available)}
        >
          {available ? 'Go Offline' : 'Go Online'}
        </button>
      </section>

      <h2 className="section-title">Your Overview</h2>

      <section className="info-grid">
        <article className="info-card">
          <span className="card-icon">🪪</span>
          <p>Driver ID</p>
          <h3>{driver.id}</h3>
        </article>

        <article className="info-card">
          <span className="card-icon">🚐</span>
          <p>Assigned Vehicle</p>
          <h3>{driver.vehicle}</h3>
        </article>

        <article className="info-card">
          <span className="card-icon">📍</span>
          <p>Operating Area</p>
          <h3>{driver.area}</h3>
        </article>

        <article className="info-card">
          <span className="card-icon">🗓️</span>
          <p>Today's Trips</p>
          <h3>—</h3>
          <small>Trip data not connected yet</small>
        </article>
      </section>

      <section className="notice">
        <strong>Trip information</strong>
        <p>
          Trip assignments and vehicle details will appear here once the
          backend APIs are connected.
        </p>
      </section>

      <footer className="dashboard-footer">
        CMRL Feeder · Driver Workspace
      </footer>
    </main>
  )
}

export default App
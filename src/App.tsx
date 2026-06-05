import { Routes, Route, NavLink } from 'react-router-dom'
import Dashboard from './pages/Dashboard'
import SectorDetail from './pages/SectorDetail'
import Trend from './pages/Trend'
import './App.css'

export default function App() {
  return (
    <div className="app">
      <nav className="nav">
        <span className="nav-brand">📊 Quant</span>
        <div className="nav-links">
          <NavLink to="/" end>대시보드</NavLink>
          <NavLink to="/sector">섹터 상세</NavLink>
          <NavLink to="/trend">트렌드</NavLink>
        </div>
      </nav>
      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/sector" element={<SectorDetail />} />
          <Route path="/trend" element={<Trend />} />
        </Routes>
      </main>
    </div>
  )
}

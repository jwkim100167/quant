import { Routes, Route, NavLink } from 'react-router-dom'
import Dashboard from './pages/Dashboard'
import SectorDetail from './pages/SectorDetail'
import Verification from './pages/Verification'
import Backtest from './pages/Backtest'
import USDashboard from './pages/USDashboard'
import USVerification from './pages/USVerification'
import USBacktest from './pages/USBacktest'
import './App.css'

export default function App() {
  return (
    <div className="app">
      <nav className="nav">
        <span className="nav-brand">📊 Quant</span>
        <div className="nav-links">
          <NavLink to="/" end>대시보드</NavLink>
          <NavLink to="/sector">섹터 상세</NavLink>
          <NavLink to="/verification">신호 검증</NavLink>
          <NavLink to="/backtest">백테스트</NavLink>
          <span style={{ color: '#30363d', margin: '0 4px' }}>|</span>
          <NavLink to="/us" end>미국 대시보드</NavLink>
          <NavLink to="/us/verification">미국 검증</NavLink>
          <NavLink to="/us/backtest">미국 백테스트</NavLink>
        </div>
      </nav>
      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/sector" element={<SectorDetail />} />
          <Route path="/verification" element={<Verification />} />
          <Route path="/backtest" element={<Backtest />} />
          <Route path="/us" element={<USDashboard />} />
          <Route path="/us/verification" element={<USVerification />} />
          <Route path="/us/backtest" element={<USBacktest />} />
        </Routes>
      </main>
    </div>
  )
}

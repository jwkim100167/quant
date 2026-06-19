import { useEffect, useState, useMemo } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts'
import { supabase } from '../lib/supabase'

const US_TICKERS = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AVGO', 'COST', 'NFLX']

const US_NAMES: Record<string, string> = {
  AAPL:  'Apple',
  MSFT:  'Microsoft',
  NVDA:  'NVIDIA',
  AMZN:  'Amazon',
  GOOGL: 'Alphabet',
  META:  'Meta',
  TSLA:  'Tesla',
  AVGO:  'Broadcom',
  COST:  'Costco',
  NFLX:  'Netflix',
}

const TICKER_COLORS: Record<string, string> = {
  AAPL:  '#3B82F6',
  MSFT:  '#06B6D4',
  NVDA:  '#10B981',
  AMZN:  '#F59E0B',
  GOOGL: '#EF4444',
  META:  '#8B5CF6',
  TSLA:  '#F97316',
  AVGO:  '#EC4899',
  COST:  '#14B8A6',
  NFLX:  '#E11D48',
}

interface TickerRow {
  ticker: string
  name: string
  count: number
  prev: number
  delta: number
}

interface ChartRow {
  week: string
  [ticker: string]: string | number
}

const TREND_OPTIONS = [13, 26, 52]

export default function USDashboard() {
  const [rows, setRows]           = useState<TickerRow[]>([])
  const [weekStart, setWeekStart] = useState('')
  const [loading, setLoading]     = useState(true)
  const [rawWeekly, setRawWeekly] = useState<Record<string, Record<string, number>>>({})
  const [allWeeks, setAllWeeks]   = useState<string[]>([])
  const [trendWeeks, setTrendWeeks]       = useState(13)
  const [activeTickers, setActiveTickers] = useState<Set<string>>(new Set(US_TICKERS))

  useEffect(() => {
    async function load() {
      setLoading(true)

      const from = new Date()
      from.setDate(from.getDate() - 52 * 7)
      const fromStr = from.toISOString().split('T')[0]

      const { data: mentions } = await supabase
        .from('raw_mentions')
        .select('ticker, mentioned_at')
        .in('ticker', US_TICKERS)
        .gte('mentioned_at', fromStr)

      if (!mentions || mentions.length === 0) { setLoading(false); return }

      // 주별·종목별 집계
      const weekTicker: Record<string, Record<string, number>> = {}
      mentions.forEach(m => {
        const d = new Date(m.mentioned_at)
        const day = d.getDay()
        const diff = day === 0 ? -6 : 1 - day
        const mon = new Date(d)
        mon.setDate(d.getDate() + diff)
        const w = mon.toISOString().split('T')[0]
        if (!weekTicker[w]) weekTicker[w] = {}
        weekTicker[w][m.ticker] = (weekTicker[w][m.ticker] ?? 0) + 1
      })

      // 완성된 주만 (이번 주 제외)
      const now = new Date()
      const daysToMon = (now.getDay() + 6) % 7
      const thisMon = new Date(now)
      thisMon.setDate(now.getDate() - daysToMon)
      thisMon.setHours(0, 0, 0, 0)
      const thisMonStr = thisMon.toISOString().slice(0, 10)

      const weeks = Object.keys(weekTicker).filter(w => w < thisMonStr).sort()
      if (weeks.length === 0) { setLoading(false); return }

      const cur  = weeks[weeks.length - 1]
      const prev = weeks[weeks.length - 2] ?? ''

      const ranking: TickerRow[] = US_TICKERS.map(t => {
        const count = weekTicker[cur]?.[t] ?? 0
        const p     = weekTicker[prev]?.[t] ?? 0
        return { ticker: t, name: US_NAMES[t], count, prev: p, delta: count - p }
      }).sort((a, b) => b.count - a.count)

      setRows(ranking)
      setWeekStart(cur)
      setRawWeekly(weekTicker)
      setAllWeeks(weeks)
      setLoading(false)
    }
    load()
  }, [])

  const chartData: ChartRow[] = useMemo(() => {
    const recent = allWeeks.slice(-trendWeeks)
    return recent.map(w => {
      const row: ChartRow = { week: w.slice(5).replace('-', '/') }
      US_TICKERS.forEach(t => { row[t] = rawWeekly[w]?.[t] ?? 0 })
      return row
    })
  }, [allWeeks, rawWeekly, trendWeeks])

  const toggleTicker = (t: string) =>
    setActiveTickers(prev => {
      const next = new Set(prev)
      next.has(t) ? next.delete(t) : next.add(t)
      return next
    })

  if (loading) return <div className="loading">데이터 불러오는 중...</div>
  if (rows.length === 0) return <div className="loading">데이터 없음</div>

  const green = '#3fb950', red = '#f85149', gray = '#8b949e'

  return (
    <div>
      <div className="page-header">
        <div className="page-title">미국 종목 언급량</div>
        <div className="page-sub">NASDAQ Top 10 · {weekStart} 기준</div>
      </div>

      {/* 순위 테이블 */}
      <div className="card" style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#6b7280', marginBottom: 12 }}>
          이번 주 언급량 순위
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ color: '#6b7280', borderBottom: '1px solid #21262d' }}>
              <th style={{ textAlign: 'left',  padding: '5px 8px' }}>#</th>
              <th style={{ textAlign: 'left',  padding: '5px 8px' }}>종목</th>
              <th style={{ textAlign: 'right', padding: '5px 8px' }}>언급량</th>
              <th style={{ textAlign: 'right', padding: '5px 8px' }}>전주 대비</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.ticker} style={{ borderBottom: '1px solid #161b22' }}>
                <td style={{ padding: '7px 8px', color: i < 3 ? '#f59e0b' : gray }}>{i + 1}</td>
                <td style={{ padding: '7px 8px' }}>
                  <span style={{ fontWeight: 600, color: TICKER_COLORS[r.ticker] }}>{r.ticker}</span>
                  <span style={{ color: '#6b7280', marginLeft: 8, fontSize: 12 }}>{r.name}</span>
                </td>
                <td style={{ padding: '7px 8px', textAlign: 'right', color: '#e6edf3', fontWeight: 600 }}>
                  {r.count.toLocaleString()}
                </td>
                <td style={{ padding: '7px 8px', textAlign: 'right', fontWeight: 600,
                  color: r.delta > 0 ? green : r.delta < 0 ? red : gray }}>
                  {r.delta > 0 ? `+${r.delta}` : r.delta === 0 ? '─' : r.delta}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 주간 추이 차트 */}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#6b7280' }}>주간 언급량 추이</div>
          <div style={{ display: 'flex', gap: 4 }}>
            {TREND_OPTIONS.map(n => (
              <button key={n} onClick={() => setTrendWeeks(n)} style={{
                padding: '3px 10px', borderRadius: 5, fontSize: 11, cursor: 'pointer',
                border: `1px solid ${trendWeeks === n ? '#a78bfa' : '#30363d'}`,
                background: trendWeeks === n ? '#a78bfa22' : 'transparent',
                color: trendWeeks === n ? '#a78bfa' : '#6b7280',
              }}>{n}주</button>
            ))}
          </div>
        </div>

        {/* 종목 토글 */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
          {US_TICKERS.map(t => (
            <button key={t} onClick={() => toggleTicker(t)} style={{
              padding: '3px 10px', borderRadius: 12, fontSize: 11, cursor: 'pointer',
              border: `1px solid ${activeTickers.has(t) ? TICKER_COLORS[t] : '#30363d'}`,
              background: activeTickers.has(t) ? TICKER_COLORS[t] + '22' : 'transparent',
              color: activeTickers.has(t) ? TICKER_COLORS[t] : '#4b5563',
            }}>{t}</button>
          ))}
        </div>

        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={chartData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
            <CartesianGrid stroke="#21262d" vertical={false} />
            <XAxis
              dataKey="week"
              tick={{ fontSize: 10, fill: '#6b7280' }}
              axisLine={false} tickLine={false}
              interval={Math.max(0, Math.floor(trendWeeks / 6) - 1)}
            />
            <YAxis tick={{ fontSize: 10, fill: '#6b7280' }} axisLine={false} tickLine={false} />
            <Tooltip
              contentStyle={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 6, fontSize: 12 }}
              labelStyle={{ color: '#6b7280' }}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {US_TICKERS.filter(t => activeTickers.has(t)).map(t => (
              <Line
                key={t} type="monotone" dataKey={t}
                stroke={TICKER_COLORS[t]} strokeWidth={1.5}
                dot={false} activeDot={{ r: 3 }}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

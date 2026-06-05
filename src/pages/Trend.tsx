import { useEffect, useState } from 'react'
import {
  LineChart, Line, XAxis, YAxis, Tooltip, Legend,
  ResponsiveContainer, CartesianGrid,
} from 'recharts'
import { supabase } from '../lib/supabase'
import { SECTOR_COLORS, SECTOR_LABELS, type WeeklyTrendRow } from '../types'

interface ChartRow {
  week: string
  [sector: string]: string | number
}

export default function Trend() {
  const [chartData, setChartData]     = useState<ChartRow[]>([])
  const [allSectors, setAllSectors]   = useState<string[]>([])
  const [active, setActive]           = useState<Set<string>>(new Set())
  const [loading, setLoading]         = useState(true)

  useEffect(() => {
    async function load() {
      const from = new Date()
      from.setDate(from.getDate() - 91) // 13주
      const fromStr = from.toISOString().split('T')[0]

      const { data } = await supabase
        .from('weekly_sector_stats')
        .select('week_start, sector_id, mention_count')
        .gte('week_start', fromStr)
        .order('week_start')

      if (!data || data.length === 0) { setLoading(false); return }

      // 주별로 그루핑
      const weekMap: Record<string, Record<string, number>> = {}
      const sectorTotals: Record<string, number> = {}

      ;(data as WeeklyTrendRow[]).forEach(row => {
        if (!weekMap[row.week_start]) weekMap[row.week_start] = {}
        weekMap[row.week_start][row.sector_id] = row.mention_count
        sectorTotals[row.sector_id] = (sectorTotals[row.sector_id] ?? 0) + row.mention_count
      })

      // 총량 상위 8개 섹터를 기본 ON
      const sortedSectors = Object.keys(sectorTotals).sort((a, b) => sectorTotals[b] - sectorTotals[a])
      setAllSectors(sortedSectors)
      setActive(new Set(sortedSectors.slice(0, 8)))

      // 차트 데이터 변환
      const rows: ChartRow[] = Object.entries(weekMap)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([week, sectors]) => ({
          week: week.slice(5).replace('-', '/'),
          ...sectors,
        }))

      setChartData(rows)
      setLoading(false)
    }
    load()
  }, [])

  function toggle(sector: string) {
    setActive(prev => {
      const next = new Set(prev)
      next.has(sector) ? next.delete(sector) : next.add(sector)
      return next
    })
  }

  if (loading) return <div className="loading">데이터 불러오는 중...</div>

  return (
    <div>
      <div className="page-header">
        <div className="page-title">주간 트렌드</div>
        <div className="page-sub">최근 13주 섹터별 언급량 추이</div>
      </div>

      <div className="chips" style={{ marginBottom: 20 }}>
        {allSectors.map(s => {
          const color = SECTOR_COLORS[s] ?? '#6b7280'
          const on = active.has(s)
          return (
            <button
              key={s}
              className={`chip${on ? ' on' : ''}`}
              style={{
                background: on ? `${color}22` : 'transparent',
                color: on ? color : '#6b7280',
                borderColor: on ? color : '#30363d',
              }}
              onClick={() => toggle(s)}
            >
              {SECTOR_LABELS[s] ?? s}
            </button>
          )
        })}
      </div>

      <div className="card">
        {chartData.length === 0 ? (
          <div className="empty">트렌드 데이터 없음 (aggregate 실행 필요)</div>
        ) : (
          <ResponsiveContainer width="100%" height={420}>
            <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
              <XAxis
                dataKey="week"
                tick={{ fill: '#8b949e', fontSize: 11 }}
                axisLine={{ stroke: '#30363d' }}
                tickLine={false}
              />
              <YAxis
                tick={{ fill: '#8b949e', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={36}
              />
              <Tooltip
                contentStyle={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 6, color: '#e6edf3', fontSize: 12 }}
                labelStyle={{ color: '#8b949e', marginBottom: 4 }}
                formatter={(value, name) => [
                  `${value}건`,
                  SECTOR_LABELS[String(name)] ?? String(name),
                ]}
              />
              <Legend
                formatter={(value: string) => (
                  <span style={{ color: '#8b949e', fontSize: 12 }}>
                    {SECTOR_LABELS[value] ?? value}
                  </span>
                )}
              />
              {allSectors.filter(s => active.has(s)).map(s => (
                <Line
                  key={s}
                  type="monotone"
                  dataKey={s}
                  stroke={SECTOR_COLORS[s] ?? '#6b7280'}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                  connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
}

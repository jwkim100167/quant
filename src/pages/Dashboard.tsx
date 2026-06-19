import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Legend } from 'recharts'
import { supabase } from '../lib/supabase'
import { SECTOR_COLORS, SECTOR_LABELS, type SectorStat } from '../types'

interface SectorRow extends SectorStat {
  delta: number | null
}

interface ChartRow {
  week: string
  [sector: string]: string | number
}

const SOURCE_COLORS = ['#3B82F6', '#10B981', '#F59E0B']
const US_SECTORS = ['NASDAQ_TOP10']

export default function Dashboard() {
  const navigate = useNavigate()
  const [rows, setRows]           = useState<SectorRow[]>([])
  const [weekStart, setWeekStart] = useState('')
  const [prevWeek, setPrevWeek]   = useState('')
  const [sourceData, setSourceData] = useState<{ name: string; value: number }[]>([])
  const [totalMentions, setTotalMentions] = useState(0)
  const [loading, setLoading]     = useState(true)
  const [chartData, setChartData]       = useState<ChartRow[]>([])
  const [allSectors, setAllSectors]     = useState<string[]>([])
  const [activeSectors, setActiveSectors] = useState<Set<string>>(new Set())
  const [trendWeeks, setTrendWeeks]       = useState(52)

  useEffect(() => {
    async function load() {
      // 최근 2주 (distinct) week_start 가져오기
      const { data: weeksRaw } = await supabase
        .from('weekly_sector_stats')
        .select('week_start')
        .order('week_start', { ascending: false })
        .limit(100)

      if (!weeksRaw || weeksRaw.length === 0) { setLoading(false); return }

      // 이번 주(월요일) 시작일 계산 — 현재 진행 중인 불완전한 주는 제외
      const now = new Date()
      const daysToMonday = (now.getDay() + 6) % 7   // 0=Mon ... 6=Sun
      const thisMonday = new Date(now)
      thisMonday.setDate(now.getDate() - daysToMonday)
      thisMonday.setHours(0, 0, 0, 0)
      const thisMondayStr = thisMonday.toISOString().slice(0, 10)

      // 완성된 주만 사용 (이번 주 week_start 제외)
      const distinctWeeks = [...new Set(weeksRaw.map(r => r.week_start as string))]
        .filter(w => w < thisMondayStr)
        .sort()
        .reverse()
      const cur  = distinctWeeks[0]
      const prev = distinctWeeks[1]
      setWeekStart(cur)
      if (prev) setPrevWeek(prev)

      // 이번 주 + 전주 섹터 통계 한 번에 조회
      const { data: stats } = await supabase
        .from('weekly_sector_stats')
        .select('week_start, sector_id, mention_count, community_count, rank')
        .in('week_start', prev ? [cur, prev] : [cur])
        .not('sector_id', 'in', `(${US_SECTORS.join(',')})`)

      const curMap: Record<string, SectorStat> = {}
      const prevMap: Record<string, number>    = {}

      stats?.forEach(r => {
        const cnt = (r.mention_count as number) - ((r.community_count as number) ?? 0)
        if (r.week_start === cur)  curMap[r.sector_id]  = { ...r, mention_count: cnt } as unknown as SectorStat
        if (r.week_start === prev) prevMap[r.sector_id] = cnt
      })

      const combined: SectorRow[] = Object.values(curMap).map(r => ({
        ...r,
        delta: prev ? r.mention_count - (prevMap[r.sector_id] ?? 0) : null,
      })).sort((a, b) => {
        if (a.sector_id === 'ETC') return 1
        if (b.sector_id === 'ETC') return -1
        return b.mention_count - a.mention_count
      })

      setRows(combined)
      setTotalMentions(combined.reduce((s, r) => s + r.mention_count, 0))

      // 소스 분포 (이번 주 기준)
      const { data: mentions } = await supabase
        .from('raw_mentions')
        .select('source')
        .neq('source', 'dart')
        .neq('source', 'community')
        .gte('mentioned_at', cur)

      if (mentions) {
        const sc: Record<string, number> = { dart: 0, naver: 0, report: 0 }
        mentions.forEach(m => { sc[m.source] = (sc[m.source] ?? 0) + 1 })
        setSourceData([
          { name: 'DART 공시', value: sc.dart },
          { name: '뉴스 RSS',  value: sc.naver },
          { name: '리서치',    value: sc.report },
        ])
      }

      setLoading(false)
    }
    load()
  }, [])

  useEffect(() => {
    async function loadTrend() {
      const from = new Date()
      from.setDate(from.getDate() - trendWeeks * 7)
      const fromStr = from.toISOString().split('T')[0]
      const { data } = await supabase
        .from('weekly_sector_stats')
        .select('week_start, sector_id, mention_count, community_count')
        .gte('week_start', fromStr)
        .not('sector_id', 'in', `(${US_SECTORS.join(',')})`)
        .order('week_start')
      if (!data || data.length === 0) return
      const weekMap: Record<string, Record<string, number>> = {}
      const sectorTotals: Record<string, number> = {}
      ;(data as { week_start: string; sector_id: string; mention_count: number; community_count: number }[]).forEach(row => {
        if (!weekMap[row.week_start]) weekMap[row.week_start] = {}
        const cnt = row.mention_count - (row.community_count ?? 0)
        weekMap[row.week_start][row.sector_id] = cnt
        sectorTotals[row.sector_id] = (sectorTotals[row.sector_id] ?? 0) + cnt
      })
      const sorted = Object.keys(sectorTotals).sort((a, b) => sectorTotals[b] - sectorTotals[a])
      setAllSectors(sorted)
      setChartData(
        Object.entries(weekMap).sort(([a], [b]) => a.localeCompare(b))
          .map(([week, sectors]) => ({ week: week.slice(5).replace('-', '/'), ...sectors }))
      )
    }
    loadTrend()
  }, [trendWeeks])

  useEffect(() => {
    if (rows.length === 0 || allSectors.length === 0) return
    const top8 = rows
      .filter(r => r.sector_id !== 'ETC' && allSectors.includes(r.sector_id))
      .slice(0, 8)
      .map(r => r.sector_id)
    setActiveSectors(new Set(top8))
  }, [rows, allSectors])

  function toggleSector(s: string) {
    setActiveSectors(prev => {
      const next = new Set(prev)
      next.has(s) ? next.delete(s) : next.add(s)
      return next
    })
  }

  const maxCount = rows[0]?.mention_count ?? 1

  if (loading) return <div className="loading">데이터 불러오는 중...</div>

  return (
    <div>
      <div className="page-header">
        <div className="page-title">섹터 대시보드</div>
        <div className="page-sub">
          {(() => {
            if (!weekStart) return null
            const end = new Date(new Date(weekStart).getTime() + 6 * 86400000)
            const endStr = `${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`
            const isLastWeek = (() => {
              const now = new Date()
              const todayMonday = new Date(now)
              todayMonday.setDate(now.getDate() - ((now.getDay() + 6) % 7))
              todayMonday.setHours(0, 0, 0, 0)
              return new Date(weekStart) < todayMonday
            })()
            return <>
              <span style={{ fontWeight: 600, color: isLastWeek ? '#f59e0b' : '#3fb950' }}>
                {isLastWeek ? '저번주' : '이번주'}
              </span>
              &nbsp;{weekStart.slice(5)} ~ {endStr}
              &nbsp;·&nbsp;총 {totalMentions.toLocaleString()}건
              {prevWeek && <>&nbsp;·&nbsp;전주 대비 변화 표시</>}
            </>
          })()}
        </div>
      </div>

      <div className="grid-2" style={{ marginBottom: 16 }}>
        {/* 섹터 언급량 순위 (바 + 수치 통합) */}
        <div className="card">
          <div className="card-title">섹터별 언급량 순위</div>
          {rows.length === 0 ? (
            <div className="empty">집계 데이터 없음 (aggregate 실행 필요)</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ color: '#8b949e', borderBottom: '1px solid #21262d' }}>
                  <th style={{ width: 28, textAlign: 'center', paddingBottom: 6 }}>#</th>
                  <th style={{ textAlign: 'left', paddingBottom: 6 }}>섹터</th>
                  <th style={{ paddingBottom: 6 }}></th>
                  <th style={{ textAlign: 'right', paddingBottom: 6 }}>언급량</th>
                  <th style={{ textAlign: 'right', paddingBottom: 6 }}>전주대비</th>
                  <th style={{ textAlign: 'right', paddingBottom: 6 }}>비율</th>
                </tr>
              </thead>
              <tbody>
                {rows.filter(r => r.sector_id !== 'ETC').map((r, i) => {
                  const color = SECTOR_COLORS[r.sector_id] ?? '#6b7280'
                  const label = SECTOR_LABELS[r.sector_id] ?? r.sector_id
                  const barPct = (r.mention_count / maxCount) * 100
                  const sharePct = totalMentions > 0 ? ((r.mention_count / totalMentions) * 100).toFixed(1) : '0'
                  return (
                    <tr key={r.sector_id} onClick={() => navigate(`/sector?sector=${r.sector_id}`)}
                      style={{ cursor: 'pointer', borderBottom: '1px solid #21262d' }}
                      onMouseEnter={e => (e.currentTarget.style.background = '#161b22')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      <td style={{ textAlign: 'center', padding: '5px 0', color: i < 3 ? ['#FFD700','#C0C0C0','#CD7F32'][i] : '#8b949e', fontWeight: 700 }}>{i + 1}</td>
                      <td style={{ padding: '5px 6px' }}>
                        <span style={{ background: `${color}22`, color, borderRadius: 4, padding: '2px 6px', fontSize: 11 }}>{label}</span>
                      </td>
                      <td style={{ width: '30%', padding: '5px 8px' }}>
                        <div style={{ background: '#21262d', borderRadius: 3, height: 6, overflow: 'hidden' }}>
                          <div style={{ width: `${barPct}%`, height: '100%', background: color, borderRadius: 3 }} />
                        </div>
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: '#58a6ff', padding: '5px 4px' }}>{r.mention_count}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600, padding: '5px 4px',
                        color: r.delta == null ? '#8b949e' : r.delta > 0 ? '#10B981' : r.delta < 0 ? '#EF4444' : '#8b949e' }}>
                        {r.delta == null ? '-' : r.delta > 0 ? `+${r.delta}` : r.delta === 0 ? '─' : r.delta}
                      </td>
                      <td style={{ textAlign: 'right', color: '#8b949e', padding: '5px 4px' }}>{sharePct}%</td>
                    </tr>
                  )
                })}
                {rows.find(r => r.sector_id === 'ETC') && (
                  <tr style={{ color: '#8b949e' }}>
                    <td colSpan={3} style={{ padding: '5px 6px', fontSize: 11 }}>기타 (분류 미정)</td>
                    <td style={{ textAlign: 'right', padding: '5px 4px', fontWeight: 600 }}>{rows.find(r => r.sector_id === 'ETC')!.mention_count}</td>
                    <td colSpan={2} />
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>

        {/* 소스 분포 파이 + 섹터 카드 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card">
            <div className="card-title">소스별 분포 (이번 주)</div>
            <ResponsiveContainer width="100%" height={160}>
              <PieChart>
                <Pie data={sourceData} cx="50%" cy="50%" outerRadius={60} dataKey="value" label={false}>
                  {sourceData.map((_, i) => <Cell key={i} fill={SOURCE_COLORS[i]} />)}
                </Pie>
                <Tooltip contentStyle={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 6, color: '#e6edf3', fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 16, marginTop: 4 }}>
              {sourceData.map((s, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12 }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: SOURCE_COLORS[i] }} />
                  <span style={{ color: '#8b949e' }}>{s.name}</span>
                  <span style={{ fontWeight: 600 }}>{s.value}</span>
                </div>
              ))}
            </div>
          </div>

          {/* TOP 3 섹터 카드 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {rows.filter(r => r.sector_id !== 'ETC').slice(0, 3).map((r, i) => {
              const color = SECTOR_COLORS[r.sector_id] ?? '#6b7280'
              const label = SECTOR_LABELS[r.sector_id] ?? r.sector_id
              const medals = ['🥇', '🥈', '🥉']
              return (
                <div key={r.sector_id} className="stat-card" style={{ borderLeft: `3px solid ${color}` }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div className="stat-label">{medals[i]} {label}</div>
                      <div className="stat-value" style={{ fontSize: 22, color }}>{r.mention_count}<span style={{ fontSize: 13, color: '#8b949e', marginLeft: 4 }}>건</span></div>
                    </div>
                    {r.delta !== null && (
                      <div style={{ fontSize: 13, fontWeight: 600, color: r.delta > 0 ? '#10B981' : r.delta < 0 ? '#EF4444' : '#8b949e' }}>
                        {r.delta > 0 ? `▲ +${r.delta}` : r.delta < 0 ? `▼ ${r.delta}` : '─'}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* 주간 트렌드 */}
      <div className="card" style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div className="card-title" style={{ marginBottom: 0 }}>주간 트렌드 <span style={{ fontSize: 12, color: '#8b949e', fontWeight: 400 }}>섹터별 언급량 추이</span></div>
          <div className="btn-group">
            {([{ w: 13, label: '3개월' }, { w: 26, label: '6개월' }, { w: 52, label: '1년' }] as { w: number; label: string }[]).map(({ w, label }) => (
              <button key={w} className={`btn${trendWeeks === w ? ' active' : ''}`} onClick={() => setTrendWeeks(w)}>{label}</button>
            ))}
          </div>
        </div>
        <div className="chips" style={{ marginBottom: 16 }}>
          {[...allSectors].sort((a, b) => {
            const ra = rows.findIndex(r => r.sector_id === a)
            const rb = rows.findIndex(r => r.sector_id === b)
            return (ra === -1 ? 999 : ra) - (rb === -1 ? 999 : rb)
          }).map(s => {
            const color = SECTOR_COLORS[s] ?? '#6b7280'
            const on = activeSectors.has(s)
            return (
              <button key={s} className={`chip${on ? ' on' : ''}`}
                style={{ background: on ? `${color}22` : 'transparent', color: on ? color : '#6b7280', borderColor: on ? color : '#30363d' }}
                onClick={() => toggleSector(s)}>
                {SECTOR_LABELS[s] ?? s}
              </button>
            )
          })}
        </div>
        {chartData.length === 0 ? (
          <div className="empty">트렌드 데이터 없음</div>
        ) : (
          <ResponsiveContainer width="100%" height={360}>
            <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
              <XAxis dataKey="week" tick={{ fill: '#8b949e', fontSize: 11 }} axisLine={{ stroke: '#30363d' }} tickLine={false} />
              <YAxis tick={{ fill: '#8b949e', fontSize: 11 }} axisLine={false} tickLine={false} width={36} />
              <Tooltip
                contentStyle={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 6, color: '#e6edf3', fontSize: 12 }}
                labelStyle={{ color: '#8b949e', marginBottom: 4 }}
                formatter={(value, name) => [`${value}건`, SECTOR_LABELS[String(name)] ?? String(name)]}
              />
              <Legend formatter={(v: string) => <span style={{ color: '#8b949e', fontSize: 12 }}>{SECTOR_LABELS[v] ?? v}</span>} />
              {allSectors.filter(s => activeSectors.has(s)).map(s => (
                <Line key={s} type="monotone" dataKey={s} stroke={SECTOR_COLORS[s] ?? '#6b7280'}
                  strokeWidth={2} dot={false} activeDot={{ r: 4 }} connectNulls />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
}

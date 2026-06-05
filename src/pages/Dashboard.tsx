import { useEffect, useState } from 'react'
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts'
import { supabase } from '../lib/supabase'
import { SECTOR_COLORS, SECTOR_LABELS, type SectorStat } from '../types'

interface SectorRow extends SectorStat {
  delta: number | null
}

const SOURCE_COLORS = ['#3B82F6', '#10B981', '#F59E0B']

export default function Dashboard() {
  const [rows, setRows]           = useState<SectorRow[]>([])
  const [weekStart, setWeekStart] = useState('')
  const [prevWeek, setPrevWeek]   = useState('')
  const [sourceData, setSourceData] = useState<{ name: string; value: number }[]>([])
  const [totalMentions, setTotalMentions] = useState(0)
  const [loading, setLoading]     = useState(true)

  useEffect(() => {
    async function load() {
      // 최근 2주 (distinct) week_start 가져오기
      const { data: weeksRaw } = await supabase
        .from('weekly_sector_stats')
        .select('week_start')
        .order('week_start', { ascending: false })
        .limit(100)

      if (!weeksRaw || weeksRaw.length === 0) { setLoading(false); return }

      const distinctWeeks = [...new Set(weeksRaw.map(r => r.week_start as string))].slice(0, 2)
      const cur  = distinctWeeks[0]
      const prev = distinctWeeks[1]
      setWeekStart(cur)
      if (prev) setPrevWeek(prev)

      // 이번 주 + 전주 섹터 통계 한 번에 조회
      const { data: stats } = await supabase
        .from('weekly_sector_stats')
        .select('week_start, sector_id, mention_count, rank')
        .in('week_start', prev ? [cur, prev] : [cur])

      const curMap: Record<string, SectorStat> = {}
      const prevMap: Record<string, number>    = {}

      stats?.forEach(r => {
        if (r.week_start === cur)  curMap[r.sector_id]  = r as unknown as SectorStat
        if (r.week_start === prev) prevMap[r.sector_id] = r.mention_count
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

  const maxCount = rows[0]?.mention_count ?? 1

  if (loading) return <div className="loading">데이터 불러오는 중...</div>

  return (
    <div>
      <div className="page-header">
        <div className="page-title">섹터 대시보드</div>
        <div className="page-sub">
          기준 주: {weekStart}&nbsp;·&nbsp;총 {totalMentions.toLocaleString()}건
          {prevWeek && <>&nbsp;·&nbsp;전주 대비 변화 표시</>}
        </div>
      </div>

      <div className="grid-2" style={{ marginBottom: 16 }}>
        {/* 섹터 랭킹 바 차트 */}
        <div className="card">
          <div className="card-title">섹터별 언급량 순위</div>
          {rows.length === 0 ? (
            <div className="empty">집계 데이터 없음 (aggregate 실행 필요)</div>
          ) : (
            <>
              {rows.filter(r => r.sector_id !== 'ETC').map(r => {
                const color = SECTOR_COLORS[r.sector_id] ?? '#6b7280'
                const label = SECTOR_LABELS[r.sector_id] ?? r.sector_id
                const pct   = (r.mention_count / maxCount) * 100
                return (
                  <div className="bar-row" key={r.sector_id}>
                    <div className="bar-label" style={{ fontSize: 11 }}>{label}</div>
                    <div className="bar-track">
                      <div className="bar-fill" style={{ width: `${pct}%`, background: color }} />
                    </div>
                    <div className="bar-count" style={{ display: 'flex', alignItems: 'center', gap: 4, width: 70 }}>
                      <span style={{ fontWeight: 600 }}>{r.mention_count}</span>
                      {r.delta !== null && r.delta !== 0 && (
                        <span style={{ fontSize: 11, color: r.delta > 0 ? '#10B981' : '#EF4444' }}>
                          {r.delta > 0 ? `+${r.delta}` : r.delta}
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
              {rows.find(r => r.sector_id === 'ETC') && (
                <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #21262d', display: 'flex', justifyContent: 'space-between', color: '#8b949e', fontSize: 12 }}>
                  <span>기타 (분류 미정)</span>
                  <span style={{ fontWeight: 600 }}>{rows.find(r => r.sector_id === 'ETC')!.mention_count}건</span>
                </div>
              )}
            </>
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

      {/* 전체 섹터 테이블 */}
      <div className="card">
        <div className="card-title">전체 섹터 순위표</div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 48 }}>순위</th>
                <th>섹터</th>
                <th style={{ textAlign: 'right' }}>언급량</th>
                <th style={{ textAlign: 'right' }}>전주 대비</th>
                <th style={{ textAlign: 'right' }}>비율</th>
              </tr>
            </thead>
            <tbody>
              {rows.filter(r => r.sector_id !== 'ETC').map((r, i) => {
                const color = SECTOR_COLORS[r.sector_id] ?? '#6b7280'
                const label = SECTOR_LABELS[r.sector_id] ?? r.sector_id
                const pct = totalMentions > 0 ? ((r.mention_count / totalMentions) * 100).toFixed(1) : '0'
                return (
                  <tr key={r.sector_id}>
                    <td><span className={`rank${i < 3 ? ` rank-${i + 1}` : ''}`}>{i + 1}</span></td>
                    <td>
                      <span className="badge" style={{ background: `${color}22`, color }}>{label}</span>
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: '#58a6ff' }}>{r.mention_count}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600, color: r.delta === null ? '#8b949e' : r.delta > 0 ? '#10B981' : r.delta < 0 ? '#EF4444' : '#8b949e' }}>
                      {r.delta === null ? '-' : r.delta > 0 ? `+${r.delta}` : r.delta === 0 ? '─' : r.delta}
                    </td>
                    <td style={{ textAlign: 'right', color: '#8b949e' }}>{pct}%</td>
                  </tr>
                )
              })}
              {rows.find(r => r.sector_id === 'ETC') && (() => {
                const etc = rows.find(r => r.sector_id === 'ETC')!
                const pct = totalMentions > 0 ? ((etc.mention_count / totalMentions) * 100).toFixed(1) : '0'
                return (
                  <tr key="ETC" style={{ opacity: 0.6 }}>
                    <td><span className="rank">-</span></td>
                    <td><span className="badge" style={{ background: '#4B556322', color: '#4B5563' }}>기타</span></td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: '#58a6ff' }}>{etc.mention_count}</td>
                    <td style={{ textAlign: 'right', color: '#8b949e' }}>-</td>
                    <td style={{ textAlign: 'right', color: '#8b949e' }}>{pct}%</td>
                  </tr>
                )
              })()}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

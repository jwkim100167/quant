import { useEffect, useState } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, PieChart, Pie, Cell,
} from 'recharts'
import { supabase } from '../lib/supabase'
import { SECTOR_COLORS, SECTOR_LABELS } from '../types'

interface WeekRow { week_start: string; mention_count: number }
interface SourceRow { source: string; count: number }

const SOURCE_COLORS = ['#3B82F6', '#10B981', '#F59E0B']
const SOURCE_LABELS: Record<string, string> = { dart: 'DART 공시', naver: '뉴스 RSS', report: '리서치' }

const ALL_SECTORS = Object.keys(SECTOR_LABELS)

export default function SectorDetail() {
  const [sector, setSector]       = useState(ALL_SECTORS[0])
  const [weeks, setWeeks]         = useState(13)
  const [weekRows, setWeekRows]   = useState<WeekRow[]>([])
  const [sourceRows, setSourceRows] = useState<SourceRow[]>([])
  const [total, setTotal]         = useState(0)
  const [loading, setLoading]     = useState(true)

  useEffect(() => {
    setLoading(true)
    async function load() {
      // 기간 from 계산
      const from = new Date()
      from.setDate(from.getDate() - weeks * 7)
      const fromStr = from.toISOString().split('T')[0]

      // weekly_sector_stats 에서 해당 섹터 주간 데이터
      const { data: wStats } = await supabase
        .from('weekly_sector_stats')
        .select('week_start, mention_count')
        .eq('sector_id', sector)
        .gte('week_start', fromStr)
        .order('week_start')

      setWeekRows((wStats ?? []).map(r => ({
        week_start: (r.week_start as string).slice(5).replace('-', '/'),
        mention_count: r.mention_count as number,
      })))

      // raw_mentions 에서 소스별 분포 (선택 섹터)
      const { data: tickerData } = await supabase
        .from('stocks')
        .select('ticker')
        .eq('sector_id', sector)

      const tickers = tickerData?.map(t => t.ticker) ?? []
      if (tickers.length > 0) {
        const { data: mentions } = await supabase
          .from('raw_mentions')
          .select('source')
          .in('ticker', tickers)
          .gte('mentioned_at', fromStr)

        const sc: Record<string, number> = {}
        mentions?.forEach(m => { sc[m.source] = (sc[m.source] ?? 0) + 1 })
        const total = Object.values(sc).reduce((a, b) => a + b, 0)
        setTotal(total)
        setSourceRows(
          Object.entries(sc).map(([source, count]) => ({ source, count }))
            .sort((a, b) => b.count - a.count)
        )
      } else {
        setTotal(0)
        setSourceRows([])
      }

      setLoading(false)
    }
    load()
  }, [sector, weeks])

  const color = SECTOR_COLORS[sector] ?? '#6b7280'
  const peakWeek = [...weekRows].sort((a, b) => b.mention_count - a.mention_count)[0]

  return (
    <div>
      <div className="page-header">
        <div className="page-title">섹터 상세</div>
        <div className="page-sub">섹터를 선택해 기간별 언급량 추이와 소스 분포를 확인합니다</div>
      </div>

      {/* 컨트롤 */}
      <div className="filters" style={{ marginBottom: 24 }}>
        <label>섹터</label>
        <select value={sector} onChange={e => setSector(e.target.value)} style={{ fontSize: 14, padding: '6px 12px' }}>
          {ALL_SECTORS.map(s => (
            <option key={s} value={s}>{SECTOR_LABELS[s]}</option>
          ))}
        </select>

        <label style={{ marginLeft: 8 }}>기간</label>
        <div className="btn-group">
          {[4, 8, 13, 26, 52].map(w => (
            <button key={w} className={`btn${weeks === w ? ' active' : ''}`} onClick={() => setWeeks(w)}>
              {w}주
            </button>
          ))}
        </div>
      </div>

      {/* 요약 카드 */}
      <div className="grid-3" style={{ marginBottom: 16 }}>
        <div className="stat-card" style={{ borderLeft: `3px solid ${color}` }}>
          <div className="stat-label">총 언급량 ({weeks}주)</div>
          <div className="stat-value" style={{ color }}>{total.toLocaleString()}</div>
          <div className="stat-sub">건</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">주간 평균</div>
          <div className="stat-value">{weekRows.length > 0 ? Math.round(total / weekRows.length).toLocaleString() : '-'}</div>
          <div className="stat-sub">건 / 주</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">최고 언급 주</div>
          <div className="stat-value" style={{ fontSize: 20 }}>{peakWeek?.week_start ?? '-'}</div>
          <div className="stat-sub">{peakWeek ? `${peakWeek.mention_count}건` : ''}</div>
        </div>
      </div>

      {loading ? <div className="loading">불러오는 중...</div> : (
        <div className="grid-2">
          {/* 주간 바 차트 */}
          <div className="card">
            <div className="card-title">주간 언급량 추이</div>
            {weekRows.length === 0 ? (
              <div className="empty">데이터 없음</div>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={weekRows} margin={{ top: 4, right: 8, bottom: 24, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#21262d" vertical={false} />
                  <XAxis dataKey="week_start" tick={{ fill: '#8b949e', fontSize: 10 }} angle={-45} textAnchor="end" interval={weeks > 13 ? 1 : 0} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: '#8b949e', fontSize: 11 }} axisLine={false} tickLine={false} width={30} />
                  <Tooltip
                    contentStyle={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 6, color: '#e6edf3', fontSize: 12 }}
                    formatter={(v) => [`${v}건`, '언급량']}
                    labelFormatter={(l) => `${l} 주`}
                  />
                  <Bar dataKey="mention_count" fill={color} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* 소스 분포 */}
          <div className="card">
            <div className="card-title">소스별 분포</div>
            {sourceRows.length === 0 ? (
              <div className="empty">데이터 없음</div>
            ) : (
              <>
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie data={sourceRows.map(r => ({ name: SOURCE_LABELS[r.source] ?? r.source, value: r.count }))}
                      cx="50%" cy="50%" outerRadius={75} dataKey="value" label={false}>
                      {sourceRows.map((_, i) => <Cell key={i} fill={SOURCE_COLORS[i % 3]} />)}
                    </Pie>
                    <Tooltip contentStyle={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 6, color: '#e6edf3', fontSize: 12 }} />
                  </PieChart>
                </ResponsiveContainer>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                  {sourceRows.map((r, i) => (
                    <div key={r.source} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ width: 10, height: 10, borderRadius: '50%', background: SOURCE_COLORS[i % 3], flexShrink: 0 }} />
                      <span style={{ color: '#8b949e', fontSize: 13, width: 72 }}>{SOURCE_LABELS[r.source] ?? r.source}</span>
                      <div className="bar-track" style={{ height: 6 }}>
                        <div className="bar-fill" style={{ width: `${(r.count / total) * 100}%`, background: SOURCE_COLORS[i % 3] }} />
                      </div>
                      <span style={{ fontSize: 13, fontWeight: 600, width: 48, textAlign: 'right' }}>{r.count}건</span>
                      <span style={{ fontSize: 11, color: '#8b949e' }}>({((r.count / total) * 100).toFixed(1)}%)</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

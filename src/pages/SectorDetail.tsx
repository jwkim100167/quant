import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, PieChart, Pie, Cell,
} from 'recharts'
import { supabase } from '../lib/supabase'
import { SECTOR_COLORS, SECTOR_LABELS } from '../types'

interface WeekRow { week_start: string; mention_count: number }
interface SourceRow { source: string; count: number }
interface StockStat {
  ticker: string; name: string
  mention_count: number; positive_count: number; negative_count: number
}

const SOURCE_COLORS = ['#3B82F6', '#10B981', '#F59E0B']
const SOURCE_LABELS: Record<string, string> = { dart: 'DART 공시', naver: '뉴스 RSS', report: '리서치' }

const ALL_SECTORS = Object.keys(SECTOR_LABELS)

export default function SectorDetail() {
  const [searchParams] = useSearchParams()
  const initSector = searchParams.get('sector') ?? ALL_SECTORS[0]
  const [sector, setSector]       = useState(ALL_SECTORS.includes(initSector) ? initSector : ALL_SECTORS[0])
  const [weeks, setWeeks]         = useState(52)
  const [weekRows, setWeekRows]   = useState<WeekRow[]>([])
  const [sourceRows, setSourceRows] = useState<SourceRow[]>([])
  const [stockStats, setStockStats] = useState<StockStat[]>([])
  const [total, setTotal]         = useState(0)
  const [loading, setLoading]     = useState(true)

  useEffect(() => {
    setLoading(true)
    async function load() {
      // 기간 from 계산 — 이번 주(미완성) 월요일 기준으로 N주 전 월요일
      const thisMonday = (() => {
        const d = new Date()
        const daysToMonday = (d.getDay() + 6) % 7   // 0=Mon … 6=Sun
        d.setDate(d.getDate() - daysToMonday)
        d.setHours(0, 0, 0, 0)
        return d
      })()
      const fromStr = weeks === 0
        ? '2018-01-01'
        : (() => { const d = new Date(thisMonday); d.setDate(d.getDate() - weeks * 7); return d.toISOString().split('T')[0] })()

      // weekly_sector_stats 에서 해당 섹터 주간 데이터
      const { data: wStats } = await supabase
        .from('weekly_sector_stats')
        .select('week_start, mention_count, community_count')
        .eq('sector_id', sector)
        .gte('week_start', fromStr)
        .order('week_start')

      setWeekRows((wStats ?? []).map(r => ({
        week_start: (r.week_start as string).slice(5).replace('-', '/'),
        mention_count: (r.mention_count as number) - (r.community_count as number ?? 0),
      })))

      // raw_mentions 에서 소스별 분포 (선택 섹터)
      const { data: tickerData } = await supabase
        .from('stocks')
        .select('ticker, name')
        .eq('sector_id', sector)

      const tickers = tickerData?.map(t => t.ticker) ?? []
      if (tickers.length > 0) {
        // 소스별 분포 + 종목별 집계 동시 조회
        const allMentions: { ticker: string; source: string; sentiment: number }[] = []
        let mOffset = 0
        while (true) {
          const { data: mentions } = await supabase
            .from('raw_mentions')
            .select('ticker, source, sentiment')
            .in('ticker', tickers)
            .neq('source', 'dart')
            .neq('source', 'community')
            .gte('mentioned_at', fromStr)
            .range(mOffset, mOffset + 999)
          if (!mentions || mentions.length === 0) break
          allMentions.push(...(mentions as typeof allMentions))
          if (mentions.length < 1000) break
          mOffset += 1000
        }

        // 소스 집계
        const sc: Record<string, number> = {}
        allMentions.forEach(m => { sc[m.source] = (sc[m.source] ?? 0) + 1 })
        const total = Object.values(sc).reduce((a, b) => a + b, 0)
        setTotal(total)
        setSourceRows(
          Object.entries(sc).map(([source, count]) => ({ source, count }))
            .sort((a, b) => b.count - a.count)
        )

        // 종목별 집계
        const nameMap: Record<string, string> = {}
        tickerData?.forEach(t => { nameMap[t.ticker] = (t as { ticker: string; name: string }).name ?? t.ticker })
        const sm: Record<string, StockStat> = {}
        for (const t of tickers) {
          sm[t] = { ticker: t, name: nameMap[t] ?? t, mention_count: 0, positive_count: 0, negative_count: 0 }
        }
        allMentions.forEach(m => {
          if (!sm[m.ticker]) return
          sm[m.ticker].mention_count++
          if (m.sentiment ===  1) sm[m.ticker].positive_count++
          if (m.sentiment === -1) sm[m.ticker].negative_count++
        })
        setStockStats(
          Object.values(sm).filter(s => s.mention_count > 0)
            .sort((a, b) => b.mention_count - a.mention_count)
        )
      } else {
        setTotal(0)
        setSourceRows([])
        setStockStats([])
      }

      setLoading(false)
    }
    load()
  }, [sector, weeks])

  const color = SECTOR_COLORS[sector] ?? '#6b7280'
  const periodLabel = ({ 0: '전체', 1: '1주', 2: '2주', 3: '3주', 13: '3개월', 26: '6개월', 52: '1년', 104: '2년', 208: '4년' } as Record<number, string>)[weeks] ?? `${weeks}주`
  const xAxisInterval = weeks === 0 ? 16 : weeks <= 3 ? 0 : weeks <= 13 ? 0 : weeks <= 26 ? 1 : weeks <= 52 ? 2 : weeks <= 104 ? 3 : 7
  const rolling13Avg = weekRows.length > 0
    ? Math.round(weekRows.slice(-13).reduce((s, r) => s + r.mention_count, 0) / Math.min(weekRows.length, 13))
    : null

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
          {([
            { w: 1,   label: '1주'   },
            { w: 2,   label: '2주'   },
            { w: 3,   label: '3주'   },
            { w: 13,  label: '3개월' },
            { w: 26,  label: '6개월' },
            { w: 52,  label: '1년'   },
            { w: 104, label: '2년'   },
            { w: 208, label: '4년'   },
            { w: 0,   label: '전체'  },
          ] as { w: number; label: string }[]).map(({ w, label }) => (
            <button key={w} className={`btn${weeks === w ? ' active' : ''}`} onClick={() => setWeeks(w)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* 요약 카드 */}
      <div className="grid-2" style={{ marginBottom: 16 }}>
        <div className="stat-card" style={{ borderLeft: `3px solid ${color}` }}>
          <div className="stat-label">총 언급량 ({periodLabel})</div>
          <div className="stat-value" style={{ color }}>{total.toLocaleString()}</div>
          <div className="stat-sub">건</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">롤링 평균 (최근 13주)</div>
          <div className="stat-value">{rolling13Avg != null ? rolling13Avg.toLocaleString() : '-'}</div>
          <div className="stat-sub">건 / 주</div>
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
                  <XAxis dataKey="week_start" tick={{ fill: '#8b949e', fontSize: 10 }} angle={-45} textAnchor="end" interval={xAxisInterval} axisLine={false} tickLine={false} />
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

      {/* 종목별 언급 상세 */}
      {stockStats.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-title">종목별 언급 상세</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ color: '#6b7280', borderBottom: '1px solid #21262d' }}>
                <th style={{ textAlign: 'left',  padding: '6px 8px' }}>#</th>
                <th style={{ textAlign: 'left',  padding: '6px 8px' }}>종목명</th>
                <th style={{ textAlign: 'left',  padding: '6px 8px', color: '#6b7280', fontSize: 11 }}>티커</th>
                <th style={{ textAlign: 'right', padding: '6px 8px' }}>언급 수</th>
                <th style={{ textAlign: 'right', padding: '6px 8px' }}>긍정</th>
                <th style={{ textAlign: 'right', padding: '6px 8px' }}>부정</th>
                <th style={{ textAlign: 'right', padding: '6px 8px' }}>긍정-부정</th>
              </tr>
            </thead>
            <tbody>
              {stockStats.map((st, i) => {
                const isLeader = i === 0
                const net = st.positive_count - st.negative_count
                return (
                  <tr key={st.ticker} style={{
                    borderBottom: '1px solid #161b22',
                    background: isLeader ? `${color}18` : 'transparent',
                  }}>
                    <td style={{ padding: '6px 8px', color: '#6b7280' }}>{i + 1}</td>
                    <td style={{ padding: '6px 8px', color: isLeader ? color : '#e6edf3', fontWeight: isLeader ? 600 : 400 }}>
                      {isLeader && (
                        <span style={{ fontSize: 10, marginRight: 6, padding: '1px 5px', borderRadius: 4,
                          background: `${color}33`, border: `1px solid ${color}55`, color }}>대장주</span>
                      )}
                      {st.name}
                    </td>
                    <td style={{ padding: '6px 8px', color: '#6b7280', fontSize: 11 }}>{st.ticker}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', color: '#e6edf3', fontWeight: isLeader ? 600 : 400 }}>
                      {st.mention_count.toLocaleString()}
                    </td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', color: '#3fb950' }}>
                      {st.positive_count.toLocaleString()}
                    </td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', color: '#f85149' }}>
                      {st.negative_count.toLocaleString()}
                    </td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 600,
                      color: net > 0 ? '#3fb950' : net < 0 ? '#f85149' : '#6b7280' }}>
                      {net > 0 ? '+' : ''}{net.toLocaleString()}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

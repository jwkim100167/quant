import { useEffect, useState, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { SECTOR_COLORS, SECTOR_LABELS, type StockCount, type Stock } from '../types'

const PERIODS = [
  { label: '1주',  days: 7  },
  { label: '2주',  days: 14 },
  { label: '1달',  days: 30 },
  { label: '3달',  days: 91 },
  { label: '6달',  days: 182 },
  { label: '1년',  days: 364 },
]

export default function StockRanking() {
  const [period, setPeriod]     = useState(7)
  const [sector, setSector]     = useState('ALL')
  const [stocks, setStocks]     = useState<StockCount[]>([])
  const [stockMap, setStockMap] = useState<Map<string, Stock>>(new Map())
  const [loading, setLoading]   = useState(true)
  const [sectors, setSectors]   = useState<string[]>([])

  // 종목 메타 한번만 로드
  useEffect(() => {
    supabase.from('stocks').select('ticker, name, sector_id').then(({ data }) => {
      if (data) {
        setStockMap(new Map(data.map(s => [s.ticker, s])))
        const uniq = [...new Set(data.map(s => s.sector_id))].sort()
        setSectors(uniq)
      }
    })
  }, [])

  // 기간 변경 시 raw_mentions 재조회
  useEffect(() => {
    setLoading(true)
    const from = new Date()
    from.setDate(from.getDate() - period)
    const fromStr = from.toISOString().split('T')[0]

    supabase
      .from('raw_mentions')
      .select('ticker, source')
      .neq('source', 'community')
      .gte('mentioned_at', fromStr)
      .then(({ data: mentions }) => {
        if (!mentions) { setLoading(false); return }

        const counts: Record<string, StockCount> = {}
        mentions.forEach(m => {
          if (!counts[m.ticker]) {
            counts[m.ticker] = { ticker: m.ticker, name: m.ticker, sector_id: '', count: 0, dart: 0, naver: 0, report: 0 }
          }
          counts[m.ticker].count++
          counts[m.ticker][m.source as 'dart' | 'naver' | 'report']++
        })

        // 이름/섹터 적용
        Object.values(counts).forEach(c => {
          const s = stockMap.get(c.ticker)
          if (s) { c.name = s.name; c.sector_id = s.sector_id }
        })

        setStocks(Object.values(counts).sort((a, b) => b.count - a.count))
        setLoading(false)
      })
  }, [period, stockMap])

  const filtered = useMemo(() =>
    sector === 'ALL' ? stocks : stocks.filter(s => s.sector_id === sector),
    [stocks, sector]
  )

  return (
    <div>
      <div className="page-header">
        <div className="page-title">종목 랭킹</div>
        <div className="page-sub">선택 기간 내 언급량 기준 순위</div>
      </div>

      <div className="filters">
        <div className="btn-group">
          {PERIODS.map(p => (
            <button
              key={p.days}
              className={`btn${period === p.days ? ' active' : ''}`}
              onClick={() => setPeriod(p.days)}
            >
              {p.label}
            </button>
          ))}
        </div>

        <label>섹터</label>
        <select value={sector} onChange={e => setSector(e.target.value)}>
          <option value="ALL">전체</option>
          {sectors.map(s => (
            <option key={s} value={s}>{SECTOR_LABELS[s] ?? s}</option>
          ))}
        </select>

        <span style={{ color: '#8b949e', fontSize: 13 }}>
          {filtered.length}개 종목
        </span>
      </div>

      <div className="card">
        {loading ? (
          <div className="loading">불러오는 중...</div>
        ) : filtered.length === 0 ? (
          <div className="empty">데이터 없음</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 48 }}>순위</th>
                  <th>종목명</th>
                  <th>섹터</th>
                  <th style={{ textAlign: 'right' }}>언급량</th>
                  <th style={{ textAlign: 'right' }}>공시</th>
                  <th style={{ textAlign: 'right' }}>뉴스</th>
                  <th style={{ textAlign: 'right' }}>리서치</th>
                  <th>비율</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 100).map((s, i) => {
                  const color = SECTOR_COLORS[s.sector_id] ?? '#6b7280'
                  const label = SECTOR_LABELS[s.sector_id] ?? s.sector_id
                  const max = filtered[0].count
                  return (
                    <tr key={s.ticker}>
                      <td>
                        <span className={`rank${i < 3 ? ` rank-${i + 1}` : ''}`}>
                          {i + 1}
                        </span>
                      </td>
                      <td>
                        <div style={{ fontWeight: 600 }}>{s.name}</div>
                        <div style={{ fontSize: 11, color: '#8b949e' }}>{s.ticker}</div>
                      </td>
                      <td>
                        <span className="badge" style={{ background: `${color}22`, color }}>
                          {label}
                        </span>
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: '#58a6ff' }}>
                        {s.count}
                      </td>
                      <td style={{ textAlign: 'right', color: '#3B82F6' }}>{s.dart || '-'}</td>
                      <td style={{ textAlign: 'right', color: '#10B981' }}>{s.naver || '-'}</td>
                      <td style={{ textAlign: 'right', color: '#F59E0B' }}>{s.report || '-'}</td>
                      <td style={{ width: 100 }}>
                        <div className="bar-track" style={{ height: 8 }}>
                          <div className="bar-fill" style={{ width: `${(s.count / max) * 100}%`, background: color }} />
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

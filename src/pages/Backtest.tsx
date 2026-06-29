import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import {
  LineChart, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, ReferenceLine, Legend,
} from 'recharts'
import { supabase } from '../lib/supabase'
import {
  SECTOR_LABELS, SECTOR_COLORS, SECTOR_ETF,
  type SectorReturn, type Stock,
  type TradeScenario, type RawStat, type UserStrategy,
} from '../types'
import { runSimulation } from '../lib/simulation'
import type { SimResult } from '../lib/simulation'

type StockSimResult = {
  sectorId: string
  sectorLabel: string
  benchLabel: string
  matrix: {
    scenario: TradeScenario
    scenarioLabel: string
    confirmWeeks: number
    totalReturn: number
    benchReturn: number | null
    beats: boolean
    matchRate: number
  }[]
  score: number
  maxScore: number
  recommend: boolean
  optimalScenario: TradeScenario
  optimalScenarioLabel: string
  optimalConfirmWeeks: number
  optimalSeries: { week: string; strat: number; bench: number | null }[]
  optimalMatchRate: number
}

const TRADE_SCENARIOS: { key: TradeScenario; label: string; desc: string }[] = [
  {
    key: 'top1_count',
    label: 'TOP1 언급량',
    desc: '롤링 기간 내 총 언급량이 가장 많은 섹터 보유.\n· TOP1 변경 시 즉시 교체\n· 언급량은 항상 존재하므로 항상 시장에 참여',
  },
  {
    key: 'top1_delta',
    label: 'TOP1 언급증가량',
    desc: '롤링 기간 대비 언급 증가량(건수)이 가장 큰 섹터 보유.\n· TOP1 변경 시 즉시 교체\n· 증가량이 0 이하(전체 감소)면 현금 대기',
  },
  {
    key: 'top1_rate',
    label: 'TOP1 언급증가율',
    desc: '롤링 기간 대비 언급 증가율(%)이 가장 높은 섹터 보유.\n· TOP1 변경 시 즉시 교체\n· 증가율이 0% 이하면 현금 대기',
  },
  {
    key: 'top1_composite',
    label: 'TOP1 혼합',
    desc: '언급량·증가량·증가율 각각을 주간 최대값 기준 0~100 정규화 후\n합산 점수 TOP1 섹터 보유.\n· 합산 점수가 평균(33점) 이하면 현금 대기',
  },
]

export default function Backtest() {
  const { user } = useAuth()
  const navigate  = useNavigate()

  const [rawStats, setRawStats]     = useState<RawStat[]>([])
  const [rawReturns, setRawReturns] = useState<SectorReturn[]>([])
  const [loading, setLoading]       = useState(true)
  const [tradeScenario, setTradeScenario] = useState<TradeScenario>('top1_composite')
  const [confirmWeeks, setConfirmWeeks]   = useState(1)
  const [simYears, setSimYears]           = useState(3)
  const [benchmarks, setBenchmarks] = useState<Record<string, { kospi200: number | null; kosdaq150: number | null }>>({})

  // 내 전략
  const [savedStrategy, setSavedStrategy]   = useState<UserStrategy | null>(null)
  const [strategyLoading, setStrategyLoading] = useState(false)
  const [showSaveModal, setShowSaveModal]   = useState(false)
  const [saving, setSaving]                 = useState(false)
  const [saveMsg, setSaveMsg]               = useState<string | null>(null)

  const [stockQuery, setStockQuery]           = useState('')
  const [stockResults, setStockResults]       = useState<Stock[]>([])
  const [selectedStock, setSelectedStock]     = useState<Stock | null>(null)
  const [searchLoading, setSearchLoading]     = useState(false)
  const [stockSimResult, setStockSimResult]   = useState<StockSimResult | null>(null)
  const [stockSimLoading, setStockSimLoading] = useState(false)
  const [stockMarket, setStockMarket]         = useState<'kospi' | 'kosdaq'>('kospi')

  useEffect(() => {
    async function load() {
      setLoading(true)

      const stats: RawStat[] = []
      let offset = 0
      while (true) {
        const { data } = await supabase
          .from('weekly_sector_stats')
          .select('week_start,sector_id,mention_count,positive_count,report_count,community_count')
          .order('week_start', { ascending: true })
          .range(offset, offset + 999)
        if (!data || data.length === 0) break
        stats.push(...(data as RawStat[]))
        if (data.length < 1000) break
        offset += 1000
      }

      const returns: SectorReturn[] = []
      offset = 0
      while (true) {
        const { data } = await supabase
          .from('weekly_sector_returns')
          .select('week_start,sector_id,return_pct')
          .order('week_start', { ascending: true })
          .range(offset, offset + 999)
        if (!data || data.length === 0) break
        returns.push(...(data as SectorReturn[]))
        if (data.length < 1000) break
        offset += 1000
      }

      setRawStats(stats)
      setRawReturns(returns)

      const benchmarkRows: { week_start: string; kospi200_ret: number | null; kosdaq150_ret: number | null }[] = []
      let bOffset = 0
      while (true) {
        const { data } = await supabase
          .from('weekly_benchmark_returns')
          .select('week_start,kospi200_ret,kosdaq150_ret')
          .order('week_start', { ascending: true })
          .range(bOffset, bOffset + 999)
        if (!data || data.length === 0) break
        benchmarkRows.push(...(data as typeof benchmarkRows))
        if (data.length < 1000) break
        bOffset += 1000
      }
      const bMap: Record<string, { kospi200: number | null; kosdaq150: number | null }> = {}
      for (const b of benchmarkRows) {
        const key = String(b.week_start).slice(0, 10)
        bMap[key] = { kospi200: b.kospi200_ret, kosdaq150: b.kosdaq150_ret }
      }
      setBenchmarks(bMap)

      setLoading(false)
    }
    load()
  }, [])

  // ── 매매 시뮬레이션 ─────────────────────────────────────────
  const [tradeSimResult, setTradeSimResult]   = useState<SimResult | null>(null)
  const [tradeSimRunning, setTradeSimRunning] = useState(false)

  const runTradeSim = useCallback((years?: number) => {
    if (rawStats.length === 0) return
    const y = years ?? simYears
    const fromDateStr =
      y > 0 ? (() => {
        const d = new Date()
        d.setFullYear(d.getFullYear() - y)
        return d.toISOString().slice(0, 10)
      })()
      : y === -1 ? (savedStrategy?.created_at?.slice(0, 10))  // 내 시작일
      : undefined  // y=0 → 전체 기간

    setTradeSimRunning(true)
    setTradeSimResult(null)
    setTimeout(() => {
      const result = runSimulation({
        rawStats,
        rawReturns,
        benchmarks,
        scenario:     tradeScenario,
        rollingWeeks: 13,
        confirmWeeks,
        sourceFilter: 'report',
        fromDate:     fromDateStr,
      })
      setTradeSimResult(result)
      setTradeSimRunning(false)
    }, 50)
  }, [rawStats, rawReturns, benchmarks, tradeScenario, confirmWeeks, simYears, savedStrategy])

  // ── 내 전략 가져오기 ─────────────────────────────────────
  const loadMyStrategy = useCallback(async () => {
    if (!user) { navigate('/login', { state: { from: '/backtest' } }); return }
    setStrategyLoading(true)
    const { data } = await supabase
      .from('user_strategies')
      .select('*')
      .eq('user_id', user.id)
      .eq('is_active', true)
      .limit(1)
      .single()
    const s = data as UserStrategy | null
    if (s) {
      setSavedStrategy(s)
      setTradeScenario(s.scenario)
      setConfirmWeeks(s.confirm_weeks)
      setSimYears(-1)  // 내 시작일 모드
      // 상태 업데이트가 비동기이므로 로드된 값으로 직접 시뮬레이션 실행
      const fromDateStr = s.created_at?.slice(0, 10)
      setTradeSimRunning(true)
      setTradeSimResult(null)
      setTimeout(() => {
        const result = runSimulation({
          rawStats, rawReturns, benchmarks,
          scenario:     s.scenario,
          rollingWeeks: 13,
          confirmWeeks: s.confirm_weeks,
          sourceFilter: 'report',
          fromDate:     fromDateStr,
        })
        setTradeSimResult(result)
        setTradeSimRunning(false)
      }, 50)
    } else {
      setSaveMsg('저장된 전략이 없습니다.')
      setTimeout(() => setSaveMsg(null), 3000)
    }
    setStrategyLoading(false)
  }, [user, rawStats, rawReturns, benchmarks, navigate])

  // ── 내 전략 저장하기 ─────────────────────────────────────
  const handleSaveClick = useCallback(async () => {
    if (!user) { navigate('/login', { state: { from: '/backtest' } }); return }
    if (!savedStrategy) {
      const { data } = await supabase
        .from('user_strategies')
        .select('*')
        .eq('user_id', user.id)
        .eq('is_active', true)
        .limit(1)
        .single()
      setSavedStrategy((data as UserStrategy) ?? null)
    }
    setShowSaveModal(true)
  }, [user, savedStrategy, navigate])

  const saveMyStrategy = useCallback(async () => {
    if (!user) return
    setSaving(true)
    const payload = {
      user_id:       user.id,
      name:          '내 전략',
      scenario:      tradeScenario,
      rolling_weeks: 13,
      confirm_weeks: confirmWeeks,
      source_filter: 'report' as const,
      sim_from_date: null,
      is_active:     true,
      updated_at:    new Date().toISOString(),
    }
    let error
    if (savedStrategy) {
      const res = await supabase.from('user_strategies').update(payload).eq('id', savedStrategy.id)
      error = res.error
      if (!error) setSavedStrategy({ ...savedStrategy, ...payload })
    } else {
      const res = await supabase.from('user_strategies').insert(payload).select('id').single()
      error = res.error
      if (!error && res.data) setSavedStrategy({ ...payload, id: res.data.id, created_at: new Date().toISOString() } as UserStrategy)
    }
    setSaving(false)
    setShowSaveModal(false)
    setSaveMsg(error ? '저장 실패: ' + error.message : '전략이 저장됐습니다.')
    setTimeout(() => setSaveMsg(null), 3000)
  }, [user, savedStrategy, tradeScenario, confirmWeeks])

  const searchStocks = useCallback(async (query: string) => {
    if (query.trim().length < 1) { setStockResults([]); return }
    setSearchLoading(true)
    const { data } = await supabase
      .from('stocks')
      .select('ticker,name,sector_id')
      .or(`name.ilike.%${query}%,ticker.ilike.%${query}%`)
      .neq('sector_id', 'NASDAQ_TOP10')
      .limit(10)
    setStockResults((data as Stock[]) ?? [])
    setSearchLoading(false)
  }, [])

  const runStockSim = useCallback(async () => {
    if (!selectedStock) return
    setStockSimLoading(true)
    setStockSimResult(null)

    // 1. Get all tickers in the sector
    const { data: sectorStocksData } = await supabase
      .from('stocks')
      .select('ticker,name')
      .eq('sector_id', selectedStock.sector_id)
    const peerTickers = ((sectorStocksData ?? []) as { ticker: string }[]).map(s => s.ticker)

    if (peerTickers.length === 0) { setStockSimLoading(false); return }

    // 2. Determine date range from available sector returns
    const sectorRets = rawReturns.filter(r => r.sector_id === selectedStock.sector_id)
    if (sectorRets.length === 0) { setStockSimLoading(false); return }
    const fromDate = String(sectorRets[0].week_start).slice(0, 10)

    // 3. Load raw mentions for all peer tickers (once)
    const allMentions: { ticker: string; mentioned_at: string }[] = []
    let offset = 0
    while (true) {
      const { data } = await supabase
        .from('raw_mentions')
        .select('ticker,mentioned_at')
        .in('ticker', peerTickers)
        .not('source', 'in', '(dart,community)')
        .gte('mentioned_at', fromDate)
        .order('mentioned_at', { ascending: true })
        .range(offset, offset + 999)
      if (!data || data.length === 0) break
      allMentions.push(...(data as { ticker: string; mentioned_at: string }[]))
      if (data.length < 1000) break
      offset += 1000
    }

    // 4. Group mentions by week and ticker
    const toMonday = (dateStr: string): string => {
      const d = new Date(dateStr)
      const day = d.getDay()
      const diff = day === 0 ? -6 : 1 - day
      d.setDate(d.getDate() + diff)
      return d.toISOString().split('T')[0]
    }
    const weekTickerMap: Record<string, Record<string, number>> = {}
    for (const m of allMentions) {
      const w = toMonday(m.mentioned_at)
      if (!weekTickerMap[w]) weekTickerMap[w] = {}
      weekTickerMap[w][m.ticker] = (weekTickerMap[w][m.ticker] ?? 0) + 1
    }

    // 5. Return / benchmark maps
    const retMap: Record<string, number> = {}
    for (const r of sectorRets) retMap[String(r.week_start).slice(0, 10)] = r.return_pct
    const benchMap: Record<string, number | null> = {}
    for (const [wk, b] of Object.entries(benchmarks)) {
      benchMap[wk] = stockMarket === 'kospi' ? b.kospi200 : b.kosdaq150
    }

    const allWeeks = [...new Set(Object.keys(weekTickerMap))].sort()

    const normalize = (values: number[]): number[] => {
      const min = Math.min(...values), max = Math.max(...values)
      if (max === min) return values.map(() => 50)
      return values.map(v => ((v - min) / (max - min)) * 100)
    }

    // 6. Run one simulation for a given scenario × confirmWeeks
    const simulate = (scenario: TradeScenario, cw: number): {
      totalReturn: number; benchReturn: number | null
      series: { week: string; strat: number; bench: number | null }[]
      matchRate: number
    } => {
      const streak: Record<string, number> = {}
      let holding = false, holdingTicker = ''
      let cumStrat = 100, cumBench = 100, hasBench = false
      let holdWeeks = 0, matchWeeks = 0
      const series: { week: string; strat: number; bench: number | null }[] = []

      for (let i = 1; i < allWeeks.length - 1; i++) {
        const wKey = allWeeks[i], prevWKey = allWeeks[i - 1], nextWKey = allWeeks[i + 1]
        const curCounts  = weekTickerMap[wKey]    ?? {}
        const prevCounts = weekTickerMap[prevWKey] ?? {}

        const stats = peerTickers.map(t => {
          const count = curCounts[t]  ?? 0
          const prev  = prevCounts[t] ?? 0
          const delta = count - prev
          const rate  = prev > 0 ? (delta / prev) * 100 : 0
          return { ticker: t, count, delta, rate }
        })

        let top1: string | null = null
        let enterSignal = true

        if (scenario === 'top1_count') {
          const s = [...stats].sort((a, b) => b.count - a.count)
          top1 = s[0]?.ticker ?? null
        } else if (scenario === 'top1_delta') {
          const s = [...stats].sort((a, b) => b.delta - a.delta)
          top1 = s[0]?.ticker ?? null; enterSignal = (s[0]?.delta ?? 0) > 0
        } else if (scenario === 'top1_rate') {
          const s = [...stats].sort((a, b) => b.rate - a.rate)
          top1 = s[0]?.ticker ?? null; enterSignal = (s[0]?.rate ?? 0) > 0
        } else {
          const nC = normalize(stats.map(t => t.count))
          const nD = normalize(stats.map(t => t.delta))
          const nR = normalize(stats.map(t => t.rate))
          const comp = stats.map((t, idx) => ({ ticker: t.ticker, score: (nC[idx] + nD[idx] + nR[idx]) / 3 }))
            .sort((a, b) => b.score - a.score)
          top1 = comp[0]?.ticker ?? null; enterSignal = (comp[0]?.score ?? 0) > 33
        }

        for (const t of peerTickers) {
          streak[t] = t === top1 && enterSignal ? (streak[t] ?? 0) + 1 : 0
        }
        const confirmed = top1 !== null && (streak[top1] ?? 0) >= cw

        const retNext   = retMap[nextWKey]   ?? 0
        const benchNext = benchMap[nextWKey] ?? null
        let weekReturn = 0

        if (confirmed) {
          if (!holding || holdingTicker !== top1!) { holding = true; holdingTicker = top1! }
          weekReturn = retNext
        } else {
          if (holding && !enterSignal) { holding = false; holdingTicker = '' }
          else if (holding) weekReturn = retNext
        }

        if (holding) {
          holdWeeks++
          if (benchNext != null && weekReturn > benchNext) matchWeeks++
        }

        cumStrat *= (1 + weekReturn / 100)
        if (benchNext != null) { cumBench *= (1 + benchNext / 100); hasBench = true }

        series.push({
          week: wKey,
          strat: parseFloat(cumStrat.toFixed(2)),
          bench: hasBench ? parseFloat(cumBench.toFixed(2)) : null,
        })
      }

      return {
        totalReturn: cumStrat - 100,
        benchReturn: hasBench ? cumBench - 100 : null,
        series,
        matchRate: holdWeeks > 0 ? (matchWeeks / holdWeeks) * 100 : 0,
      }
    }

    // 7. Score all 12 combinations
    const CONFIRM_WEEKS = [1, 2, 3]
    const allSeries: Record<string, { week: string; strat: number; bench: number | null }[]> = {}
    const matrix: StockSimResult['matrix'] = []
    for (const s of TRADE_SCENARIOS) {
      for (const cw of CONFIRM_WEEKS) {
        const { totalReturn, benchReturn, series, matchRate } = simulate(s.key, cw)
        const beats = benchReturn !== null ? totalReturn > benchReturn : false
        matrix.push({ scenario: s.key, scenarioLabel: s.label, confirmWeeks: cw, totalReturn, benchReturn, beats, matchRate })
        allSeries[`${s.key}_${cw}`] = series
      }
    }

    const score    = matrix.filter(m => m.beats).length
    const maxScore = matrix.length  // 12

    // 최적 조합: 벤치 초과분(totalReturn - benchReturn)이 가장 큰 combo
    const optimal = matrix.reduce((best, m) => {
      const margin = m.benchReturn != null ? m.totalReturn - m.benchReturn : m.totalReturn
      const bestMargin = best.benchReturn != null ? best.totalReturn - best.benchReturn : best.totalReturn
      return margin > bestMargin ? m : best
    }, matrix[0])

    setStockSimResult({
      sectorId: selectedStock.sector_id,
      sectorLabel: SECTOR_LABELS[selectedStock.sector_id] ?? selectedStock.sector_id,
      benchLabel: stockMarket === 'kospi' ? 'KOSPI200' : 'KOSDAQ150',
      matrix, score, maxScore,
      recommend: score >= Math.ceil(maxScore / 2),
      optimalScenario: optimal.scenario,
      optimalScenarioLabel: optimal.scenarioLabel,
      optimalConfirmWeeks: optimal.confirmWeeks,
      optimalSeries: allSeries[`${optimal.scenario}_${optimal.confirmWeeks}`] ?? [],
      optimalMatchRate: optimal.matchRate,
    })
    setStockSimLoading(false)
  }, [selectedStock, rawReturns, benchmarks, stockMarket])

  if (loading) return <div className="loading">데이터 불러오는 중...</div>

  const green = '#3fb950', red = '#f85149', gray = '#8b949e'
  const myStartWeeks = savedStrategy?.created_at
    ? Math.round((Date.now() - new Date(savedStrategy.created_at).getTime()) / (7 * 24 * 60 * 60 * 1000))
    : null
  const firstDataDate = rawStats.length > 0
    ? [...new Set(rawStats.map(r => r.week_start))].sort()[0]?.slice(0, 10) ?? '-'
    : '-'

  return (
    <div>
      <div className="page-header">
        <div className="page-title">시뮬레이션</div>
        <div className="page-sub">섹터 매매 시뮬레이션 및 종목 점수 분석</div>
      </div>

      {/* ── 데모 배너 ─────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 14,
        padding: '12px 18px', borderRadius: 10,
        background: '#0d1f3c', border: '1px dashed #1f6feb',
        marginBottom: 16,
      }}>
        <div style={{ flex: 1 }}>
          <span style={{ fontSize: 12, color: '#58a6ff', fontWeight: 600 }}>📊 데모 시뮬레이션</span>
          <span style={{ fontSize: 12, color: '#6b7280', marginLeft: 10 }}>
            로그인 없이 · TOP1 언급증가량 · 3주 연속 확인 · 최근 3년
          </span>
        </div>
        <button
          className="btn active"
          style={{ whiteSpace: 'nowrap', padding: '6px 16px', fontSize: 13 }}
          disabled={tradeSimRunning || rawStats.length === 0}
          onClick={() => {
            setTradeScenario('top1_delta')
            setConfirmWeeks(3)
            setSimYears(3)
            if (rawStats.length === 0) return
            const d = new Date(); d.setFullYear(d.getFullYear() - 3)
            const fromDateStr = d.toISOString().slice(0, 10)
            setTradeSimRunning(true); setTradeSimResult(null)
            setTimeout(() => {
              const result = runSimulation({
                rawStats, rawReturns, benchmarks,
                scenario: 'top1_delta', rollingWeeks: 13,
                confirmWeeks: 3, sourceFilter: 'report',
                fromDate: fromDateStr,
              })
              setTradeSimResult(result); setTradeSimRunning(false)
            }, 50)
          }}
        >
          {tradeSimRunning ? '계산 중...' : '데모 실행'}
        </button>
      </div>

      {/* ── 전략 설정 + 누적 수익률 추이 (합친 카드) ──────── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-title">전략 설정</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* 시나리오 */}
          <div>
            <div style={{ fontSize: 12, color: gray, marginBottom: 8 }}>시나리오</div>
            <div className="btn-group">
              {TRADE_SCENARIOS.map(s => (
                <button
                  key={s.key}
                  className={`btn${tradeScenario === s.key ? ' active' : ''}`}
                  onClick={() => setTradeScenario(s.key)}
                  title={s.desc}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          {/* 연속 확인 주수 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ fontSize: 12, color: gray }}>TOP1 연속 확인</div>
            <select
              value={confirmWeeks}
              onChange={e => setConfirmWeeks(Number(e.target.value))}
              style={{ width: 100 }}
            >
              {Array.from({ length: 10 }, (_, i) => i + 1).map(n => (
                <option key={n} value={n}>{n}주</option>
              ))}
            </select>
          </div>

          {/* 도움말 */}
          <div style={{
            padding: '8px 12px', borderRadius: 6,
            background: '#0d1117', border: '1px solid #21262d',
            fontSize: 11, color: '#6b7280', lineHeight: 1.9,
          }}>
            <span>· 시뮬레이션 시작 가능일: <span style={{ color: '#e6edf3' }}>{firstDataDate}</span></span>
            <span style={{ margin: '0 10px' }}>·</span>
            <span>소스: <span style={{ color: '#e6edf3' }}>리포트(기관)</span></span>
            <span style={{ margin: '0 10px' }}>·</span>
            <span>롤링 윈도우: <span style={{ color: '#e6edf3' }}>13주</span></span>
          </div>

          {/* 내 전략 가져오기 / 저장하기 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button
              className="btn"
              onClick={loadMyStrategy}
              disabled={strategyLoading || !rawStats.length}
            >
              {strategyLoading ? '불러오는 중...' : '내 전략 가져오기'}
            </button>
            <button
              className="btn"
              onClick={handleSaveClick}
            >
              내 전략 저장하기
            </button>
            {saveMsg && (
              <span style={{ fontSize: 12, color: saveMsg.startsWith('저장 실패') ? red : saveMsg.startsWith('저장된') ? '#f59e0b' : green }}>
                {saveMsg}
              </span>
            )}
          </div>

          {/* 기간 선택 + 시뮬레이션 실행 버튼 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: gray }}>기간</span>
            <div className="btn-group">
              <button
                className={`btn${simYears === -1 ? ' active' : ''}`}
                style={{ padding: '4px 10px', fontSize: 12 }}
                onClick={() => setSimYears(-1)}
                disabled={!savedStrategy}
                title={savedStrategy ? `시작일: ${savedStrategy.created_at.slice(0, 10)}` : '내 전략을 먼저 가져오세요'}
              >
                내 시작일{myStartWeeks != null ? ` (${myStartWeeks}w)` : ''}
              </button>
              {[1, 2, 3, 5, 10].map(y => (
                <button
                  key={y}
                  className={`btn${simYears === y ? ' active' : ''}`}
                  style={{ padding: '4px 10px', fontSize: 12 }}
                  onClick={() => setSimYears(y)}
                >
                  {y}년
                </button>
              ))}
              <button
                className={`btn${simYears === 0 ? ' active' : ''}`}
                style={{ padding: '4px 10px', fontSize: 12 }}
                onClick={() => setSimYears(0)}
              >
                전체
              </button>
            </div>
            <button
              className="btn active"
              style={{ marginLeft: 8 }}
              onClick={() => runTradeSim()}
              disabled={tradeSimRunning || rawStats.length === 0}
            >
              {tradeSimRunning ? '계산 중...' : '시뮬레이션 실행'}
            </button>
          </div>

          {/* 차트 */}
          {tradeSimRunning ? (
            <div className="loading" style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              계산 중...
            </div>
          ) : tradeSimResult && tradeSimResult.series.length > 0 ? (
            <>
              <div style={{ fontSize: 12, color: gray }}>
                전략 vs KOSPI200 vs KOSDAQ150 (기준: 100)
              </div>
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={tradeSimResult.series} margin={{ top: 8, right: 16, bottom: 20, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
                  <XAxis
                    dataKey="week"
                    tick={{ fill: '#6b7280', fontSize: 10 }}
                    axisLine={{ stroke: '#30363d' }} tickLine={false}
                    tickFormatter={v => String(v).slice(0, 7)}
                    interval={Math.max(1, Math.floor(tradeSimResult.series.length / 8))}
                  />
                  <YAxis
                    tick={{ fill: '#8b949e', fontSize: 11 }}
                    axisLine={false} tickLine={false} width={50}
                    tickFormatter={v => String(v.toFixed(0))}
                  />
                  <Tooltip
                    contentStyle={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 6, fontSize: 11 }}
                    formatter={(val: unknown) => [`${Number(val).toFixed(2)}`]}
                    labelFormatter={l => String(l)}
                  />
                  <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
                  <ReferenceLine y={100} stroke="#30363d" strokeDasharray="4 2" />
                  <Line type="monotone" dataKey="strat"     name="전략"      stroke="#3B82F6" dot={false} strokeWidth={2}   connectNulls />
                  <Line type="monotone" dataKey="kospi200"  name="KOSPI200"  stroke="#f59e0b" dot={false} strokeWidth={1.5} connectNulls strokeDasharray="5 3" />
                  <Line type="monotone" dataKey="kosdaq150" name="KOSDAQ150" stroke="#a855f7" dot={false} strokeWidth={1.5} connectNulls strokeDasharray="5 3" />
                </LineChart>
              </ResponsiveContainer>
            </>
          ) : !tradeSimRunning && !tradeSimResult ? (
            <div style={{ color: gray, fontSize: 13, padding: '20px 0', textAlign: 'center' }}>
              버튼을 눌러 시뮬레이션을 시작합니다.
            </div>
          ) : null}
        </div>
      </div>

      {/* ── 매매 로그 ──────────────────────────────────────── */}
      {tradeSimResult && tradeSimResult.tradeLog.length > 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <details>
            <summary style={{ fontSize: 13, color: gray, cursor: 'pointer', userSelect: 'none', marginBottom: 4 }}>
              매매 로그 ({tradeSimResult.nBuys}회 매수 / {tradeSimResult.nSells}회 매도)
            </summary>
            <div style={{ marginTop: 12, maxHeight: 240, overflowY: 'auto' }}>
              <table>
                <thead>
                  <tr style={{ color: gray, borderBottom: '1px solid #21262d' }}>
                    <th style={{ textAlign: 'left', padding: '4px 8px' }}>주차</th>
                    <th style={{ textAlign: 'left', padding: '4px 8px' }}>액션</th>
                    <th style={{ textAlign: 'left', padding: '4px 8px' }}>섹터</th>
                    <th style={{ textAlign: 'left', padding: '4px 8px' }}>사유</th>
                  </tr>
                </thead>
                <tbody>
                  {[...tradeSimResult.tradeLog].reverse().map((t, i) => (
                    <tr key={i}>
                      <td style={{ padding: '4px 8px', fontSize: 12 }}>{t.week}</td>
                      <td style={{ padding: '4px 8px', fontSize: 12 }}>
                        <span style={{ color: t.action === 'BUY' ? green : red, fontWeight: 600 }}>
                          {t.action === 'BUY' ? '매수' : '매도'}
                        </span>
                      </td>
                      <td style={{ padding: '4px 8px', fontSize: 12 }}>
                        {t.sectors.map(s => {
                          const etf = SECTOR_ETF[s]
                          return (
                            <span key={s}>
                              {SECTOR_LABELS[s] ?? s}
                              {etf && (
                                <span style={{ marginLeft: 6, fontSize: 10, color: '#6b7280' }}>
                                  ({etf.name} · {etf.ticker})
                                </span>
                              )}
                            </span>
                          )
                        })}
                      </td>
                      <td style={{ padding: '4px 8px', fontSize: 11, color: gray }}>{t.reason ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </div>
      )}

      {/* ── 현재 보유 종목 + 전략 성과 ───────────────────── */}
      {(tradeSimResult || tradeSimRunning) && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 16, marginBottom: 20 }}>
          {/* 현재 보유 종목 */}
          <div className="card">
            <div className="card-title">현재 보유 종목</div>
            {tradeSimRunning ? (
              <div className="loading" style={{ padding: '20px 0' }}>계산 중...</div>
            ) : tradeSimResult && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{
                  padding: '16px', borderRadius: 8,
                  border: `1px solid ${tradeSimResult.currentHolding ? '#1f6feb' : '#30363d'}`,
                  background: tradeSimResult.currentHolding ? '#0d1f3c' : '#161b22',
                }}>
                  <div style={{ fontSize: 11, color: gray, marginBottom: 6 }}>
                    현재 포지션 ({tradeSimResult.currentWeek ?? '-'})
                  </div>
                  {tradeSimResult.currentHolding ? (
                    <div>
                      {tradeSimResult.currentHolding.map(s => {
                        const etf = SECTOR_ETF[s]
                        return (
                          <div key={s}>
                            <div style={{ fontSize: 18, fontWeight: 700, color: SECTOR_COLORS[s] ?? '#e6edf3', marginBottom: 4 }}>
                              {SECTOR_LABELS[s] ?? s}
                            </div>
                            {etf && (
                              <div style={{ fontSize: 12, color: '#6b7280' }}>
                                {etf.name} · {etf.ticker}
                              </div>
                            )}
                          </div>
                        )
                      })}
                      <div style={{ marginTop: 8 }}>
                        <span style={{
                          fontSize: 11, padding: '2px 8px', borderRadius: 4,
                          background: '#1f6feb22', border: '1px solid #1f6feb66', color: '#58a6ff',
                        }}>
                          HOLD
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <div style={{ fontSize: 18, fontWeight: 700, color: gray }}>현금 대기</div>
                      <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>신호 없음</div>
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                    <span style={{ color: gray }}>보유 기간</span>
                    <span style={{ color: '#e6edf3' }}>{tradeSimResult.holdWeeks}주</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                    <span style={{ color: gray }}>현금 기간</span>
                    <span style={{ color: '#e6edf3' }}>{tradeSimResult.cashWeeks}주</span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* 전략 성과 */}
          <div className="card">
            <div className="card-title">전략 성과</div>
            {tradeSimRunning ? (
              <div className="loading" style={{ padding: '20px 0' }}>계산 중...</div>
            ) : tradeSimResult && (
              <div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
                  {[
                    { label: '누적 수익률',   val: `${tradeSimResult.totalReturn >= 0 ? '+' : ''}${tradeSimResult.totalReturn.toFixed(2)}%`, color: tradeSimResult.totalReturn >= 0 ? green : red },
                    { label: '연환산 수익률', val: `${tradeSimResult.annReturn >= 0 ? '+' : ''}${tradeSimResult.annReturn.toFixed(2)}%`,     color: tradeSimResult.annReturn   >= 0 ? green : red },
                    { label: 'MDD',           val: `-${tradeSimResult.maxDrawdown.toFixed(2)}%`, color: red },
                    { label: '주간 승률',     val: `${tradeSimResult.winRate.toFixed(1)}%`,       color: tradeSimResult.winRate >= 50 ? green : red },
                  ].map(m => (
                    <div key={m.label} style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: 11, color: gray, marginBottom: 4 }}>{m.label}</div>
                      <div style={{ fontSize: 18, fontWeight: 700, color: m.color }}>{m.val}</div>
                    </div>
                  ))}
                </div>
                {tradeSimResult.benchKospi != null && (
                  <div style={{ display: 'flex', gap: 16, fontSize: 12, flexWrap: 'wrap' }}>
                    <span style={{ color: gray }}>
                      vs KOSPI200&nbsp;
                      <span style={{ color: tradeSimResult.totalReturn >= tradeSimResult.benchKospi ? green : red, fontWeight: 600 }}>
                        {`${(tradeSimResult.totalReturn - tradeSimResult.benchKospi) >= 0 ? '+' : ''}${(tradeSimResult.totalReturn - tradeSimResult.benchKospi).toFixed(2)}%`} 초과
                      </span>
                    </span>
                    {tradeSimResult.benchKosdaq != null && (
                      <span style={{ color: gray }}>
                        vs KOSDAQ150&nbsp;
                        <span style={{ color: tradeSimResult.totalReturn >= tradeSimResult.benchKosdaq ? green : red, fontWeight: 600 }}>
                          {`${(tradeSimResult.totalReturn - tradeSimResult.benchKosdaq) >= 0 ? '+' : ''}${(tradeSimResult.totalReturn - tradeSimResult.benchKosdaq).toFixed(2)}%`} 초과
                        </span>
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── 전략 저장 비교 모달 ─────────────────────────────── */}
      {showSaveModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        }}>
          <div style={{
            background: '#161b22', border: '1px solid #30363d', borderRadius: 12,
            padding: '32px 28px', maxWidth: 480, width: '90%',
          }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#e6edf3', marginBottom: 20 }}>
              내 전략 저장
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 24 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #30363d' }}>
                  <th style={{ textAlign: 'left', padding: '6px 8px', color: gray, fontWeight: 400 }}>항목</th>
                  <th style={{ textAlign: 'center', padding: '6px 8px', color: gray, fontWeight: 400 }}>기존</th>
                  <th style={{ textAlign: 'center', padding: '6px 8px', color: gray, fontWeight: 400 }}>저장할 값</th>
                </tr>
              </thead>
              <tbody>
                <tr style={{ borderBottom: '1px solid #21262d' }}>
                  <td style={{ padding: '10px 8px', color: gray }}>시나리오</td>
                  <td style={{ padding: '10px 8px', textAlign: 'center', color: savedStrategy ? '#8b949e' : '#4b5563' }}>
                    {savedStrategy
                      ? (TRADE_SCENARIOS.find(s => s.key === savedStrategy.scenario)?.label ?? savedStrategy.scenario)
                      : '없음 (최초 저장)'}
                  </td>
                  <td style={{ padding: '10px 8px', textAlign: 'center', color: '#e6edf3', fontWeight: 600 }}>
                    {TRADE_SCENARIOS.find(s => s.key === tradeScenario)?.label ?? tradeScenario}
                  </td>
                </tr>
                <tr>
                  <td style={{ padding: '10px 8px', color: gray }}>TOP1 연속 확인</td>
                  <td style={{ padding: '10px 8px', textAlign: 'center', color: savedStrategy ? '#8b949e' : '#4b5563' }}>
                    {savedStrategy ? `${savedStrategy.confirm_weeks}주` : '-'}
                  </td>
                  <td style={{ padding: '10px 8px', textAlign: 'center', color: '#e6edf3', fontWeight: 600 }}>
                    {confirmWeeks}주
                  </td>
                </tr>
              </tbody>
            </table>
            <div style={{ fontSize: 12, color: '#f59e0b', marginBottom: 20 }}>
              저장 후 마이페이지에서 자동매매를 시작할 수 있습니다.
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setShowSaveModal(false)}>취소</button>
              <button
                style={{
                  padding: '8px 20px', background: '#1f6feb', border: 'none',
                  borderRadius: 6, color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer',
                }}
                onClick={saveMyStrategy}
                disabled={saving}
              >
                {saving ? '저장 중...' : '저장하기'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 특정종목 시뮬레이션 */}
      <div style={{ marginTop: 40, borderTop: '1px solid #21262d', paddingTop: 28 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#e6edf3', marginBottom: 4 }}>특정종목 시뮬레이션</div>
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 14 }}>
          종목의 섹터 내 TOP1 추적 시뮬레이션 · 수익률은 섹터 수익률을 프록시로 사용
        </div>

        {/* 벤치마크 */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 16 }}>
          <span style={{ fontSize: 12, color: '#6b7280' }}>시장:</span>
          {([{ value: 'kospi' as const, label: '코스피 (KOSPI200)' }, { value: 'kosdaq' as const, label: '코스닥 (KOSDAQ150)' }]).map(opt => (
            <button
              key={opt.value}
              onClick={() => setStockMarket(opt.value)}
              style={{
                padding: '3px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                border: `1px solid ${stockMarket === opt.value ? '#f59e0b' : '#30363d'}`,
                background: stockMarket === opt.value ? '#f59e0b22' : 'transparent',
                color: stockMarket === opt.value ? '#f59e0b' : '#6b7280',
              }}
            >
              {opt.label}
            </button>
          ))}
          <span style={{ fontSize: 11, color: '#4b5563' }}>· 4시나리오 × 3연속 = 12가지 조합 자동 평가</span>
        </div>

        {/* 검색창 */}
        <div style={{ position: 'relative', maxWidth: 360 }}>
          <input
            type="text"
            placeholder="종목명 또는 티커 검색 (예: 삼성전자, 005930)"
            value={stockQuery}
            onChange={e => {
              setStockQuery(e.target.value)
              searchStocks(e.target.value)
            }}
            style={{
              width: '100%', boxSizing: 'border-box',
              padding: '8px 12px', borderRadius: 8, fontSize: 13,
              border: '1px solid #30363d', background: '#0d1117', color: '#e6edf3',
              outline: 'none',
            }}
          />
          {searchLoading && (
            <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', color: '#6b7280', fontSize: 11 }}>
              검색 중...
            </span>
          )}
          {stockResults.length > 0 && (
            <div style={{
              position: 'absolute', top: '110%', left: 0, right: 0, zIndex: 100,
              background: '#161b22', border: '1px solid #30363d', borderRadius: 8,
              overflow: 'hidden',
            }}>
              {stockResults.map(s => (
                <div
                  key={s.ticker}
                  onClick={() => {
                    setSelectedStock(s)
                    setStockQuery(s.name)
                    setStockResults([])
                    setStockSimResult(null)
                  }}
                  style={{
                    padding: '8px 14px', cursor: 'pointer', fontSize: 13,
                    color: '#e6edf3', borderBottom: '1px solid #21262d',
                    display: 'flex', gap: 10, alignItems: 'center',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#1c2128')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <span style={{ color: '#a78bfa', fontWeight: 600 }}>{s.ticker}</span>
                  <span>{s.name}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: '#6b7280' }}>
                    {SECTOR_LABELS[s.sector_id] ?? s.sector_id}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 선택된 종목 + 실행 버튼 */}
        {selectedStock && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 12 }}>
            <span style={{
              padding: '4px 12px', borderRadius: 20, background: '#1c2128',
              border: '1px solid #30363d', fontSize: 12, color: '#c9d1d9',
            }}>
              {selectedStock.name} ({selectedStock.ticker}) · {SECTOR_LABELS[selectedStock.sector_id] ?? selectedStock.sector_id}
            </span>
            <button
              onClick={runStockSim}
              disabled={stockSimLoading}
              style={{
                padding: '6px 18px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                cursor: stockSimLoading ? 'not-allowed' : 'pointer',
                border: '1px solid #a78bfa',
                background: stockSimLoading ? '#1c2128' : '#a78bfa22',
                color: stockSimLoading ? '#6b7280' : '#a78bfa',
              }}
            >
              {stockSimLoading ? '시뮬레이션 중...' : '시뮬레이션 실행'}
            </button>
          </div>
        )}

        {/* 결과 */}
        {stockSimResult && (() => {
          const r = stockSimResult
          const fmtR = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`
          const CONFIRM_LABELS = ['즉시(1주)', '2주 연속', '3주 연속']
          const optCell = r.matrix.find(m => m.scenario === r.optimalScenario && m.confirmWeeks === r.optimalConfirmWeeks)!
          const matchColor = r.optimalMatchRate >= 60 ? green : r.optimalMatchRate >= 45 ? '#f59e0b' : red
          return (
            <div style={{ marginTop: 20, borderRadius: 12, border: '1px solid #21262d', background: '#0d1117', overflow: 'hidden' }}>
              {/* 헤더 + 결론 */}
              <div style={{
                padding: '18px 24px',
                background: r.recommend ? '#052e16' : '#2d0a0a',
                borderBottom: `1px solid ${r.recommend ? '#16a34a44' : '#dc262644'}`,
                display: 'flex', alignItems: 'center', gap: 20,
              }}>
                <div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#e6edf3' }}>
                    {selectedStock!.name}
                    <span style={{ fontSize: 12, color: '#6b7280', marginLeft: 8 }}>({selectedStock!.ticker})</span>
                  </div>
                  <div style={{ fontSize: 12, color: '#a78bfa', marginTop: 2 }}>{r.sectorLabel} 섹터</div>
                </div>
                <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
                  <div style={{ fontSize: 28, fontWeight: 800, color: r.recommend ? green : red }}>
                    {r.score} <span style={{ fontSize: 16, color: '#6b7280', fontWeight: 400 }}>/ {r.maxScore}점</span>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: r.recommend ? green : red }}>
                    {r.recommend ? '✓ 추천합니다' : '✗ 추천하지 않습니다'}
                  </div>
                  <div style={{ fontSize: 10, color: '#6b7280', marginTop: 2 }}>
                    {r.benchLabel} 초과 조합 {r.score}/{r.maxScore} · 7점 이상 추천
                  </div>
                </div>
              </div>

              {/* 최적 시나리오 섹션 */}
              <div style={{ padding: '20px 24px', borderBottom: '1px solid #21262d' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                  <span style={{
                    padding: '2px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600,
                    background: '#a78bfa22', border: '1px solid #a78bfa55', color: '#a78bfa',
                  }}>최적 시나리오</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#e6edf3' }}>
                    {r.optimalScenarioLabel}
                  </span>
                  <span style={{ fontSize: 12, color: '#6b7280' }}>
                    · {r.optimalConfirmWeeks === 1 ? '즉시(1주)' : `${r.optimalConfirmWeeks}주 연속`}
                  </span>
                  <span style={{ marginLeft: 'auto', fontSize: 12, color: optCell.beats ? green : red, fontWeight: 600 }}>
                    전략 {fmtR(optCell.totalReturn)} / 벤치 {optCell.benchReturn != null ? fmtR(optCell.benchReturn) : '-'}
                  </span>
                </div>

                {/* 매칭확률 + 차트 나란히 */}
                <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
                  {/* 매칭확률 카드 */}
                  <div style={{
                    flexShrink: 0, width: 120,
                    background: '#161b22', borderRadius: 10, border: '1px solid #21262d',
                    padding: '16px 12px', textAlign: 'center',
                  }}>
                    <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 8 }}>주간 매칭확률</div>
                    <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                      <svg width="88" height="88" viewBox="0 0 88 88">
                        <circle cx="44" cy="44" r="36" fill="none" stroke="#21262d" strokeWidth="8" />
                        <circle
                          cx="44" cy="44" r="36" fill="none"
                          stroke={matchColor} strokeWidth="8"
                          strokeDasharray={`${2 * Math.PI * 36 * r.optimalMatchRate / 100} ${2 * Math.PI * 36}`}
                          strokeLinecap="round"
                          transform="rotate(-90 44 44)"
                          style={{ transition: 'stroke-dasharray 0.6s ease' }}
                        />
                      </svg>
                      <div style={{ position: 'absolute', textAlign: 'center' }}>
                        <div style={{ fontSize: 18, fontWeight: 800, color: matchColor, lineHeight: 1 }}>
                          {r.optimalMatchRate.toFixed(0)}%
                        </div>
                      </div>
                    </div>
                    <div style={{ fontSize: 10, color: '#6b7280', marginTop: 6, lineHeight: 1.5 }}>
                      보유 주 중<br />벤치 초과 비율
                    </div>
                  </div>

                  {/* 누적 수익률 차트 */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6 }}>
                      누적 수익률 추이 — 전략(파랑) vs {r.benchLabel}(주황)
                    </div>
                    <ResponsiveContainer width="100%" height={200}>
                      <LineChart data={r.optimalSeries} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
                        <XAxis
                          dataKey="week"
                          tick={{ fill: '#6b7280', fontSize: 9 }}
                          axisLine={false} tickLine={false}
                          tickFormatter={v => String(v).slice(0, 7)}
                          interval={Math.max(1, Math.floor(r.optimalSeries.length / 6))}
                        />
                        <YAxis
                          tick={{ fill: '#8b949e', fontSize: 10 }}
                          axisLine={false} tickLine={false} width={44}
                          tickFormatter={v => String(v.toFixed(0))}
                        />
                        <Tooltip
                          contentStyle={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 6, fontSize: 11 }}
                          formatter={(val: unknown, name: unknown) => [`${Number(val).toFixed(1)}`, String(name)]}
                          labelFormatter={l => String(l)}
                        />
                        <ReferenceLine y={100} stroke="#30363d" strokeDasharray="4 2" />
                        <Line type="monotone" dataKey="strat" name="전략" stroke="#3B82F6" dot={false} strokeWidth={2} connectNulls />
                        <Line type="monotone" dataKey="bench" name={r.benchLabel} stroke="#f59e0b" dot={false} strokeWidth={1.5} connectNulls strokeDasharray="5 3" />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>

              {/* 매트릭스 테이블 */}
              <div style={{ padding: '20px 24px' }}>
                <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
                  각 조합의 누적 수익률이 {r.benchLabel}을 초과하면 +1점
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #21262d' }}>
                      <th style={{ textAlign: 'left', padding: '6px 10px', color: '#6b7280', fontWeight: 400 }}>시나리오</th>
                      {CONFIRM_LABELS.map(cl => (
                        <th key={cl} style={{ textAlign: 'center', padding: '6px 10px', color: '#6b7280', fontWeight: 400 }}>{cl}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {TRADE_SCENARIOS.map(s => (
                      <tr key={s.key} style={{ borderBottom: '1px solid #161b22' }}>
                        <td style={{ padding: '8px 10px', color: '#c9d1d9', fontWeight: 500 }}>{s.label}</td>
                        {[1, 2, 3].map(cw => {
                          const cell = r.matrix.find(m => m.scenario === s.key && m.confirmWeeks === cw)!
                          const isOptimal = s.key === r.optimalScenario && cw === r.optimalConfirmWeeks
                          return (
                            <td key={cw} style={{ padding: '8px 10px', textAlign: 'center' }}>
                              <div style={{
                                display: 'inline-flex', flexDirection: 'column', alignItems: 'center',
                                padding: '4px 12px', borderRadius: 6, minWidth: 80,
                                background: cell.beats ? '#052e16' : '#2d0a0a',
                                border: `1px solid ${isOptimal ? '#a78bfa' : cell.beats ? '#16a34a44' : '#dc262644'}`,
                                boxShadow: isOptimal ? '0 0 0 1px #a78bfa44' : 'none',
                              }}>
                                {isOptimal && (
                                  <span style={{ fontSize: 9, color: '#a78bfa', marginBottom: 2, fontWeight: 600 }}>BEST</span>
                                )}
                                <span style={{ fontSize: 13, fontWeight: 700, color: cell.beats ? green : red }}>
                                  {cell.beats ? '+1' : '0'}
                                </span>
                                <span style={{ fontSize: 10, color: '#6b7280', marginTop: 1 }}>
                                  전략 {fmtR(cell.totalReturn)}
                                </span>
                                <span style={{ fontSize: 10, color: '#4b5563' }}>
                                  벤치 {cell.benchReturn != null ? fmtR(cell.benchReturn) : '-'}
                                </span>
                              </div>
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )
        })()}
      </div>
    </div>
  )
}

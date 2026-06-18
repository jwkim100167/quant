import { useEffect, useState, useMemo, useCallback } from 'react'
import {
  LineChart, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, ReferenceLine, Legend,
  BarChart, Bar, Cell,
} from 'recharts'
import { supabase } from '../lib/supabase'
import {
  SECTOR_LABELS, SECTOR_COLORS,
  type BacktestRow, type SectorReturn, type Stock,
} from '../types'

type StockSimResult = {
  sectorId: string
  sectorLabel: string
  weeklyMentions: number[]
  weekDates: string[]
  upWeeks: number
  downWeeks: number
  streak: number
  ytdMultiplier: number
  score: number
  recommend: boolean
  rollingWindow: number
}

const ROLLING_WINDOW_OPTIONS = [
  { label: '4주',        value: 4  },
  { label: '8주',        value: 8  },
  { label: '13주 (분기)', value: 13 },
  { label: '26주 (반기)', value: 26 },
]

type TradeScenario = 'top1_track' | 'market_signal_3w' | 'market_signal_2w' | 'hybrid_optimal'
const TRADE_SCENARIOS: { key: TradeScenario; label: string; desc: string }[] = [
  {
    key: 'hybrid_optimal',
    label: '최적 복합',
    desc: '두 전략의 장점 결합.\n· TOP1 변경 시 즉시 교체 (top1_track 강점)\n· 시장 전체 3주 연속 하락 시 현금 (market_signal 강점)\n· 현금 중 시장 회복 시 언급량 1위 재진입',
  },
  {
    key: 'top1_track',
    label: 'TOP1 추적',
    desc: '언급 증가량 1위 섹터 보유.\n1.1 1위 변경 시 즉시 교체\n1.2 보유 섹터 2주 연속 하락 시 → 언급량 최다 섹터로 전환',
  },
  {
    key: 'market_signal_3w',
    label: '시장전체 3주 하락→언급량1위',
    desc: '시장 전체 언급량 증가 시 언급량 1위 섹터 매수.\n3주 연속 시장 전체 감소 시 전량 매도 → 현금\n현금 중 시장 회복 시 언급량 1위 재매수',
  },
  {
    key: 'market_signal_2w',
    label: '시장전체 2주 하락→언급량1위',
    desc: '시장 전체 언급량 증가 시 언급량 1위 섹터 매수.\n2주 연속 시장 전체 감소 시 전량 매도 → 현금\n현금 중 시장 회복 시 언급량 1위 재매수',
  },
]

type RawStat = {
  week_start:      string
  sector_id:       string
  mention_count:   number
  positive_count:  number
  report_count:    number
  community_count: number
}
type SourceFilter = 'all' | 'report' | 'community'

export default function Backtest() {
  const [rawStats, setRawStats]     = useState<RawStat[]>([])
  const [rawReturns, setRawReturns] = useState<SectorReturn[]>([])
  const [loading, setLoading]       = useState(true)
  const [rollingWeeks, setRollingWeeks] = useState(13)
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('report')
  const [tradeScenario, setTradeScenario]     = useState<TradeScenario>('hybrid_optimal')
  const [hoveredScenario, setHoveredScenario] = useState<TradeScenario | null>(null)
  const [benchmarks, setBenchmarks] = useState<Record<string, { kospi200: number | null; kosdaq150: number | null }>>({})

  const [stockQuery, setStockQuery]           = useState('')
  const [stockResults, setStockResults]       = useState<Stock[]>([])
  const [selectedStock, setSelectedStock]     = useState<Stock | null>(null)
  const [searchLoading, setSearchLoading]     = useState(false)
  const [stockSimResult, setStockSimResult]   = useState<StockSimResult | null>(null)
  const [stockSimLoading, setStockSimLoading] = useState(false)

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

  // ── 소스 필터 적용 → 주간 BacktestRow 생성 ─────────────────
  const rows = useMemo((): BacktestRow[] => {
    if (rawStats.length === 0 || rawReturns.length === 0) return []

    const countMap: Record<string, Record<string, number>> = {}
    const posCountMap: Record<string, Record<string, number>> = {}
    for (const s of rawStats) {
      if (!countMap[s.week_start])    countMap[s.week_start]    = {}
      if (!posCountMap[s.week_start]) posCountMap[s.week_start] = {}
      const cnt = sourceFilter === 'report'    ? (s.report_count    ?? 0)
                : sourceFilter === 'community' ? (s.community_count ?? 0)
                : s.mention_count
      countMap[s.week_start][s.sector_id]    = cnt
      posCountMap[s.week_start][s.sector_id] = s.positive_count ?? 0
    }

    const returnMap: Record<string, Record<string, number>> = {}
    for (const r of rawReturns) {
      if (!returnMap[r.week_start]) returnMap[r.week_start] = {}
      returnMap[r.week_start][r.sector_id] = r.return_pct
    }

    const weeks = [...new Set(rawStats.map(r => r.week_start))].sort()
    const result: BacktestRow[] = []
    for (let i = 1; i < weeks.length - 1; i++) {
      const prev = weeks[i - 1]; const cur = weeks[i]; const next = weeks[i + 1]
      const curCounts     = countMap[cur]     ?? {}
      const prevCounts    = countMap[prev]    ?? {}
      const nextReturns   = returnMap[next]   ?? {}
      const curPosCounts  = posCountMap[cur]  ?? {}
      const prevPosCounts = posCountMap[prev] ?? {}
      for (const [sid, count] of Object.entries(curCounts)) {
        const prevCount    = prevCounts[sid]    ?? 0
        const posCount     = curPosCounts[sid]  ?? 0
        const prevPosCount = prevPosCounts[sid] ?? 0
        result.push({
          week_start:       cur,
          return_week:      next,
          sector_id:        sid,
          mention_delta:    count - prevCount,
          positive_delta:   posCount - prevPosCount,
          mention_count:    count,
          positive_count:   posCount,
          next_week_return: nextReturns[sid] ?? null,
        })
      }
    }
    return result
  }, [rawStats, rawReturns, sourceFilter])

  // ── 롤링 집계 ──────────────────────────────────────────────
  const rollingRows = useMemo(() => {
    if (rows.length === 0) return []
    const N = rollingWeeks
    const allWeeks = [...new Set(rows.map(r => String(r.week_start).slice(0, 10)))].sort()
    const sectors  = [...new Set(rows.map(r => r.sector_id))]

    const cntMap: Record<string, Record<string, number>> = {}
    const posMap: Record<string, Record<string, number>> = {}
    const retMap: Record<string, Record<string, number | null>> = {}
    for (const r of rows) {
      const w = String(r.week_start).slice(0, 10)
      if (!cntMap[w]) { cntMap[w] = {}; posMap[w] = {}; retMap[w] = {} }
      cntMap[w][r.sector_id] = r.mention_count
      posMap[w][r.sector_id] = r.positive_count
      retMap[w][r.sector_id] = r.next_week_return
    }

    const result: BacktestRow[] = []
    for (let i = 2 * N - 1; i < allWeeks.length - 1; i++) {
      const W     = allWeeks[i]
      const Wnext = allWeeks[i + 1]
      for (const sid of sectors) {
        let roll = 0, posRoll = 0, prevRoll = 0, prevPosRoll = 0
        for (let j = 0; j < N; j++) {
          roll    += cntMap[allWeeks[i - j]]?.[sid]     ?? 0
          posRoll += posMap[allWeeks[i - j]]?.[sid]     ?? 0
        }
        for (let j = N; j < 2 * N; j++) {
          prevRoll    += cntMap[allWeeks[i - j]]?.[sid] ?? 0
          prevPosRoll += posMap[allWeeks[i - j]]?.[sid] ?? 0
        }
        if (roll === 0 && prevRoll === 0) continue
        result.push({
          week_start:       W,
          return_week:      Wnext,
          sector_id:        sid,
          mention_count:    roll,
          mention_delta:    roll - prevRoll,
          positive_count:   posRoll,
          positive_delta:   posRoll - prevPosRoll,
          next_week_return: retMap[W]?.[sid] ?? null,
        })
      }
    }
    return result
  }, [rows, rollingWeeks])

  const activeRows       = rollingRows
  const activeBenchmarks = benchmarks

  // ── 매매 시뮬레이션 ─────────────────────────────────────────
  interface TradeLog { week: string; action: 'BUY' | 'SELL'; sectors: string[]; reason?: string }
  interface TradeSimResult {
    series:      { week: string; strat: number; kospi200: number | null; kosdaq150: number | null }[]
    totalReturn: number
    annReturn:   number
    maxDrawdown: number
    winRate:     number
    nBuys:       number
    nSells:      number
    holdWeeks:   number
    cashWeeks:   number
    benchKospi:  number | null
    benchKosdaq: number | null
    tradeLog:       TradeLog[]
    currentHolding: string[] | null
    currentWeek:    string | null
  }
  const [tradeSimResult, setTradeSimResult]   = useState<TradeSimResult | null>(null)
  const [tradeSimRunning, setTradeSimRunning] = useState(false)

  const runTradeSim = useCallback(() => {
    setTradeSimRunning(true)
    setTradeSimResult(null)
    setTimeout(() => {
      const allPeriodKeys = [...new Set(activeRows.map(r => String(r.week_start).slice(0, 10)))].sort()
      const annFactor = 52

      let holdingArr: string[] = []
      let declines = 0

      const series: TradeSimResult['series'] = []
      const tradeLog: TradeLog[] = []
      let cumStrat = 100, cumKospi = 100, cumKosdaq = 100
      let peak = 100, maxDD = 0
      let holdWeeks = 0, cashWeeks = 0, wins = 0
      let hasBenchKospi = false, hasBenchKosdaq = false

      const applyReturn = (sids: string[], wRows: typeof activeRows) => {
        const rets = wRows
          .filter(r => sids.includes(r.sector_id) && r.next_week_return !== null)
          .map(r => r.next_week_return!)
        return rets.length > 0 ? rets.reduce((a, b) => a + b, 0) / rets.length : 0
      }

      for (const wKey of allPeriodKeys) {
        const wRows = activeRows.filter(r => String(r.week_start).slice(0, 10) === wKey)
        if (wRows.length === 0) continue

        const returnWeek = wRows[0]?.return_week ? String(wRows[0].return_week).slice(0, 10) : null
        const bench = returnWeek ? activeBenchmarks[returnWeek] : undefined

        const tradeable = wRows.filter(r => r.sector_id !== 'ETC')
        const byDelta = [...tradeable].sort((a, b) => b.mention_delta - a.mention_delta)
        const byCount = [...tradeable].sort((a, b) => b.mention_count  - a.mention_count)
        const top1Delta  = byDelta[0]?.sector_id ?? null
        const top1Count  = byCount[0]?.sector_id ?? null
        const totalDelta = wRows.reduce((s, r) => s + r.mention_delta, 0)

        let weekReturn = 0
        const isHolding = holdingArr.length > 0

        if (tradeScenario === 'top1_track') {
          const h = holdingArr[0] ?? null
          if (h !== null) {
            const heldDelta = wRows.find(r => r.sector_id === h)?.mention_delta ?? 0
            if (top1Delta !== null && top1Delta !== h) {
              tradeLog.push({ week: wKey, action: 'SELL', sectors: [h],         reason: '1.1 TOP1 변경' })
              tradeLog.push({ week: wKey, action: 'BUY',  sectors: [top1Delta], reason: '1.1 TOP1 변경' })
              holdingArr = [top1Delta]; declines = 0
            } else if (heldDelta < 0) {
              declines++
              if (declines >= 2) {
                tradeLog.push({ week: wKey, action: 'SELL', sectors: [h], reason: '1.2 2주 연속 하락' })
                holdingArr = top1Count ? [top1Count] : []
                if (holdingArr.length > 0)
                  tradeLog.push({ week: wKey, action: 'BUY', sectors: holdingArr, reason: '1.2 언급량 최다' })
                declines = 0
              }
            } else { declines = 0 }
            weekReturn = applyReturn(holdingArr, wRows)
            if (holdingArr.length > 0) { holdWeeks++; if (weekReturn > 0) wins++ } else cashWeeks++
          } else {
            if (top1Delta && (byDelta[0]?.mention_delta ?? 0) > 0) {
              holdingArr = [top1Delta]; declines = 0
              tradeLog.push({ week: wKey, action: 'BUY', sectors: holdingArr, reason: '진입' })
              weekReturn = applyReturn(holdingArr, wRows)
              holdWeeks++; if (weekReturn > 0) wins++
            } else cashWeeks++
          }

        } else if (tradeScenario === 'market_signal_3w' || tradeScenario === 'market_signal_2w') {
          const declineThreshold = tradeScenario === 'market_signal_3w' ? 3 : 2
          if (isHolding) {
            if (totalDelta <= 0) {
              declines++
              if (declines >= declineThreshold) {
                tradeLog.push({ week: wKey, action: 'SELL', sectors: holdingArr, reason: `${declineThreshold}주 연속 시장 하락` })
                holdingArr = []; declines = 0; cashWeeks++
              } else {
                weekReturn = applyReturn(holdingArr, wRows)
                holdWeeks++; if (weekReturn > 0) wins++
              }
            } else {
              declines = 0
              weekReturn = applyReturn(holdingArr, wRows)
              holdWeeks++; if (weekReturn > 0) wins++
            }
          } else {
            if (totalDelta > 0) {
              holdingArr = top1Count ? [top1Count] : []; declines = 0
              if (holdingArr.length > 0) {
                tradeLog.push({ week: wKey, action: 'BUY', sectors: holdingArr, reason: '진입 (언급량 1위)' })
                weekReturn = applyReturn(holdingArr, wRows)
                holdWeeks++; if (weekReturn > 0) wins++
              } else cashWeeks++
            } else cashWeeks++
          }

        } else {
          // 최적 복합
          if (isHolding) {
            const h = holdingArr[0] ?? null
            if (h !== null && top1Delta !== null && top1Delta !== h) {
              tradeLog.push({ week: wKey, action: 'SELL', sectors: [h],         reason: 'TOP1 변경' })
              tradeLog.push({ week: wKey, action: 'BUY',  sectors: [top1Delta], reason: 'TOP1 변경' })
              holdingArr = [top1Delta]; declines = 0
            } else if (totalDelta <= 0) {
              declines++
              if (declines >= 3) {
                tradeLog.push({ week: wKey, action: 'SELL', sectors: holdingArr, reason: '3주 연속 시장 하락' })
                holdingArr = []; declines = 0
              }
            } else {
              declines = 0
            }
            if (holdingArr.length > 0) {
              weekReturn = applyReturn(holdingArr, wRows)
              holdWeeks++; if (weekReturn > 0) wins++
            } else cashWeeks++
          } else {
            if (totalDelta > 0) {
              holdingArr = top1Count ? [top1Count] : []; declines = 0
              if (holdingArr.length > 0) {
                tradeLog.push({ week: wKey, action: 'BUY', sectors: holdingArr, reason: '진입 (언급량 1위)' })
                weekReturn = applyReturn(holdingArr, wRows)
                holdWeeks++; if (weekReturn > 0) wins++
              } else cashWeeks++
            } else cashWeeks++
          }
        }

        cumStrat *= (1 + weekReturn / 100)
        if (bench?.kospi200  != null) { cumKospi  *= (1 + bench.kospi200  / 100); hasBenchKospi  = true }
        if (bench?.kosdaq150 != null) { cumKosdaq *= (1 + bench.kosdaq150 / 100); hasBenchKosdaq = true }

        if (cumStrat > peak) peak = cumStrat
        const dd = (peak - cumStrat) / peak * 100
        if (dd > maxDD) maxDD = dd

        series.push({
          week: wKey,
          strat:    parseFloat(cumStrat.toFixed(2)),
          kospi200:  bench?.kospi200  != null ? parseFloat(cumKospi.toFixed(2))  : null,
          kosdaq150: bench?.kosdaq150 != null ? parseFloat(cumKosdaq.toFixed(2)) : null,
        })
      }

      const nPeriods = allPeriodKeys.length
      const totalReturn = cumStrat - 100
      const annReturn = nPeriods > 0 ? (Math.pow(cumStrat / 100, annFactor / nPeriods) - 1) * 100 : 0
      const currentHolding = holdingArr.length > 0 ? holdingArr : null
      const currentWeek    = allPeriodKeys[allPeriodKeys.length - 1] ?? null

      setTradeSimResult({
        series, totalReturn, annReturn,
        maxDrawdown: maxDD,
        winRate:   holdWeeks > 0 ? wins / holdWeeks * 100 : 0,
        nBuys:     tradeLog.filter(t => t.action === 'BUY').length,
        nSells:    tradeLog.filter(t => t.action === 'SELL').length,
        holdWeeks, cashWeeks,
        benchKospi:  hasBenchKospi  ? cumKospi  - 100 : null,
        benchKosdaq: hasBenchKosdaq ? cumKosdaq - 100 : null,
        tradeLog, currentHolding, currentWeek,
      })
      setTradeSimRunning(false)
    }, 50)
  }, [activeRows, activeBenchmarks, tradeScenario])

  // ── 전략 최적화 그리드 서치 ────────────────────────────────
  interface OptResult {
    label:       string
    topN:        number
    exitTrigger: string
    declineN:    number
    afterSell:   string
    totalReturn: number
    annReturn:   number
    winRate:     number
    maxDrawdown: number
    holdWeeks:   number
    cashWeeks:   number
    nTrades:     number
  }
  const [optResults, setOptResults] = useState<OptResult[]>([])
  const [optRunning, setOptRunning] = useState(false)
  const [optSortKey, setOptSortKey] = useState<keyof OptResult>('totalReturn')

  const runOptimization = useCallback(() => {
    setOptRunning(true)
    setOptResults([])
    setTimeout(() => {
      const allKeys = [...new Set(activeRows.map(r => String(r.week_start).slice(0, 10)))].sort()
      const annFactor = 52
      const results: OptResult[] = []

      const TOP_NS        = [1, 2, 3]
      const EXIT_TRIGGERS = ['held_delta', 'market_delta']
      const DECLINE_NS    = [1, 2, 3]
      const AFTER_SELLS   = ['cash', 'count_top']

      const simulate = (
        tN: number, exitTrigger: string, declineN: number, afterSell: string
      ): Omit<OptResult, 'label' | 'topN' | 'exitTrigger' | 'declineN' | 'afterSell'> => {
        let holdingArr: string[] = []
        let declines = 0
        let cumStrat = 100
        let peak = 100, maxDD = 0
        let holdWeeks = 0, cashWeeks = 0, wins = 0, nTrades = 0

        for (const wKey of allKeys) {
          const wRows = activeRows.filter(r => String(r.week_start).slice(0, 10) === wKey)
          if (wRows.length === 0) continue

          const tradeable  = wRows.filter(r => r.sector_id !== 'ETC')
          const byDelta    = [...tradeable].sort((a, b) => b.mention_delta - a.mention_delta)
          const byCount    = [...tradeable].sort((a, b) => b.mention_count  - a.mention_count)
          const topNSids   = byDelta.slice(0, tN).map(r => r.sector_id)
          const top1Count  = byCount[0]?.sector_id ?? null
          const totalDelta = wRows.reduce((s, r) => s + r.mention_delta, 0)

          const getReturn = (sids: string[]) => {
            const rets = wRows
              .filter(r => sids.includes(r.sector_id) && r.next_week_return !== null)
              .map(r => r.next_week_return!)
            return rets.length > 0 ? rets.reduce((a, b) => a + b, 0) / rets.length : 0
          }

          const declineSignal = exitTrigger === 'market_delta'
            ? totalDelta < 0
            : holdingArr.length > 0 &&
              (wRows.find(r => r.sector_id === holdingArr[0])?.mention_delta ?? 0) < 0

          let weekReturn = 0

          if (holdingArr.length > 0) {
            if (declineSignal) {
              declines++
              if (declines >= declineN) {
                nTrades++
                if (afterSell === 'count_top' && top1Count) {
                  holdingArr = [top1Count]; nTrades++; declines = 0
                } else {
                  holdingArr = []; declines = 0
                }
              }
            } else {
              declines = 0
              const newTop = byDelta.slice(0, tN).map(r => r.sector_id).join(',')
              if (newTop !== holdingArr.join(',')) {
                nTrades += 2; holdingArr = topNSids
              }
            }
            weekReturn = getReturn(holdingArr)
            if (holdingArr.length > 0) { holdWeeks++; if (weekReturn > 0) wins++ }
            else cashWeeks++
          } else {
            if ((byDelta[0]?.mention_delta ?? 0) > 0) {
              holdingArr = topNSids; declines = 0; nTrades++
              weekReturn = getReturn(holdingArr)
              holdWeeks++; if (weekReturn > 0) wins++
            } else cashWeeks++
          }

          cumStrat *= (1 + weekReturn / 100)
          if (cumStrat > peak) peak = cumStrat
          const dd = (peak - cumStrat) / peak * 100
          if (dd > maxDD) maxDD = dd
        }

        const nPeriods = allKeys.length
        return {
          totalReturn: cumStrat - 100,
          annReturn:   nPeriods > 0 ? (Math.pow(cumStrat / 100, annFactor / nPeriods) - 1) * 100 : 0,
          winRate:     holdWeeks > 0 ? wins / holdWeeks * 100 : 0,
          maxDrawdown: maxDD,
          holdWeeks, cashWeeks, nTrades,
        }
      }

      for (const tN of TOP_NS) {
        for (const et of EXIT_TRIGGERS) {
          for (const dn of DECLINE_NS) {
            for (const as of AFTER_SELLS) {
              const metrics = simulate(tN, et, dn, as)
              const exitLabel  = et === 'market_delta' ? '시장전체' : '보유섹터'
              const afterLabel = as === 'cash' ? '현금대기' : '언급량1위매수'
              results.push({
                label: `TOP${tN} · ${exitLabel} ${dn}주연속하락→${afterLabel}`,
                topN: tN, exitTrigger: et, declineN: dn, afterSell: as,
                ...metrics,
              })
            }
          }
        }
      }

      results.sort((a, b) => b.totalReturn - a.totalReturn)
      setOptResults(results)
      setOptRunning(false)
    }, 50)
  }, [activeRows])

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

    // 1. 52주 언급량 집계
    const now = new Date()
    const from = new Date(now)
    from.setDate(from.getDate() - 52 * 7)
    const fromStr = from.toISOString().split('T')[0]

    const { data: mentions } = await supabase
      .from('raw_mentions')
      .select('mentioned_at')
      .eq('ticker', selectedStock.ticker)
      .gte('mentioned_at', fromStr)

    const weekMap: Record<string, number> = {}
    mentions?.forEach(m => {
      const d = new Date(m.mentioned_at)
      const day = d.getDay()
      const diff = day === 0 ? -6 : 1 - day
      const mon = new Date(d)
      mon.setDate(d.getDate() + diff)
      const key = mon.toISOString().split('T')[0]
      weekMap[key] = (weekMap[key] ?? 0) + 1
    })

    const weeks: string[] = []
    for (let i = 51; i >= 0; i--) {
      const d = new Date(now)
      d.setDate(d.getDate() - i * 7)
      const day = d.getDay()
      const diff = day === 0 ? -6 : 1 - day
      const mon = new Date(d)
      mon.setDate(d.getDate() + diff)
      weeks.push(mon.toISOString().split('T')[0])
    }
    const weeklyMentions = weeks.map(w => weekMap[w] ?? 0)

    // 롤링 윈도우 기준으로 상승/하락/연속 계산
    const rollingSlice = weeklyMentions.slice(-rollingWeeks)
    const comparisons = rollingSlice.length - 1

    let upWeeks = 0, downWeeks = 0
    for (let i = 1; i < rollingSlice.length; i++) {
      if (rollingSlice[i] > rollingSlice[i - 1]) upWeeks++
      else if (rollingSlice[i] < rollingSlice[i - 1]) downWeeks++
    }

    let streak = 0
    for (let i = rollingSlice.length - 1; i >= 1; i--) {
      if (rollingSlice[i] > rollingSlice[i - 1]) {
        if (streak >= 0) streak++
        else break
      } else if (rollingSlice[i] < rollingSlice[i - 1]) {
        if (streak <= 0) streak--
        else break
      } else break
    }

    // 2. 연초 대비 섹터 수익률
    const ytdStart = `${now.getFullYear()}-01-01`
    const sectorRets = rawReturns.filter(
      r => r.sector_id === selectedStock.sector_id && r.week_start >= ytdStart
    )
    const ytdMultiplier = sectorRets.reduce((acc, r) => acc * (1 + (r.return_pct ?? 0) / 100), 1)

    // 3. 복합 점수 (롤링 윈도우 기준, ≥50% → +2, ≥40% → +1)
    const upRate = comparisons > 0 ? upWeeks / comparisons : 0
    let score = 0
    if (upRate >= 1 / 2) score += 2
    else if (upRate >= 2 / 5) score += 1
    if (streak >= 3) score += 2
    else if (streak >= 2) score += 1
    if (ytdMultiplier >= 1.1) score += 1

    setStockSimResult({
      sectorId: selectedStock.sector_id,
      sectorLabel: SECTOR_LABELS[selectedStock.sector_id] ?? selectedStock.sector_id,
      weeklyMentions,
      weekDates: weeks,
      upWeeks,
      downWeeks,
      streak,
      ytdMultiplier,
      score,
      recommend: score >= 3,
      rollingWindow: rollingWeeks,
    })
    setStockSimLoading(false)
  }, [selectedStock, rawReturns, rollingWeeks])

  if (loading) return <div className="loading">데이터 불러오는 중...</div>

  const green = '#3fb950', red = '#f85149', gray = '#8b949e'

  return (
    <div>
      <div className="page-header">
        <div className="page-title">백테스트</div>
        <div className="page-sub">매매 시뮬레이션 및 전략 최적화</div>
      </div>

      {/* 데이터 설정 */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 20, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: '#6b7280' }}>롤링 윈도우:</span>
          {ROLLING_WINDOW_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setRollingWeeks(opt.value)}
              style={{
                padding: '3px 8px', borderRadius: 5, fontSize: 11, cursor: 'pointer',
                border: `1px solid ${rollingWeeks === opt.value ? '#a78bfa' : '#30363d'}`,
                background: rollingWeeks === opt.value ? '#a78bfa22' : 'transparent',
                color: rollingWeeks === opt.value ? '#a78bfa' : '#6b7280',
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: '#6b7280' }}>소스:</span>
          {([
            { key: 'all',       label: '합산' },
            { key: 'report',    label: '리포트(기관)' },
            { key: 'community', label: '종토방(개인)' },
          ] as { key: SourceFilter; label: string }[]).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setSourceFilter(key)}
              style={{
                padding: '4px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                border: `1px solid ${sourceFilter === key ? '#f97316' : '#30363d'}`,
                background: sourceFilter === key ? '#f9731622' : 'transparent',
                color: sourceFilter === key ? '#f97316' : '#6b7280',
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* 매매 시뮬레이션 */}
      <div className="card" style={{ marginBottom: 20 }}>
        {/* 시나리오 선택 */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: '#6b7280' }}>시나리오:</span>
            {TRADE_SCENARIOS.map(s => (
              <button
                key={s.key}
                onClick={() => setTradeScenario(s.key)}
                onMouseEnter={() => setHoveredScenario(s.key)}
                onMouseLeave={() => setHoveredScenario(null)}
                style={{
                  padding: '4px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                  border: `1px solid ${tradeScenario === s.key ? '#a78bfa' : '#30363d'}`,
                  background: tradeScenario === s.key ? '#a78bfa22' : 'transparent',
                  color: tradeScenario === s.key ? '#a78bfa' : '#6b7280',
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
          {hoveredScenario && (() => {
            const s = TRADE_SCENARIOS.find(x => x.key === hoveredScenario)!
            return (
              <div style={{
                marginTop: 8, padding: '8px 12px', borderRadius: 6,
                background: '#161b22', border: '1px solid #30363d',
                fontSize: 11, color: '#8b949e', lineHeight: 1.7, whiteSpace: 'pre-line',
              }}>
                <span style={{ color: '#a78bfa', fontWeight: 600 }}>{s.label}</span>{'  '}
                {s.desc}
              </div>
            )
          })()}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
          <div style={{ color: '#e6edf3', fontSize: 14, fontWeight: 600 }}>매매 시뮬레이션</div>
          <div style={{ fontSize: 12, color: '#6b7280' }}>
            {TRADE_SCENARIOS.find(s => s.key === tradeScenario)?.label}
          </div>
          <button
            onClick={runTradeSim}
            disabled={tradeSimRunning || activeRows.length === 0}
            style={{
              marginLeft: 'auto', padding: '5px 14px', borderRadius: 6,
              border: '1px solid #30363d',
              background: tradeSimRunning ? '#21262d' : '#1f6feb',
              color: '#fff', cursor: tradeSimRunning ? 'not-allowed' : 'pointer', fontSize: 12,
            }}
          >
            {tradeSimRunning ? '시뮬레이션 중...' : '시뮬레이션 실행'}
          </button>
        </div>

        {!tradeSimResult && !tradeSimRunning && (
          <div style={{ color: '#6b7280', fontSize: 13 }}>
            버튼을 눌러 실제 매매 시뮬레이션을 시작합니다. <span style={{ color: '#8b949e' }}>(전체 기간 데이터 기준)</span>
          </div>
        )}

        {tradeSimResult && (() => {
          const fmtR = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
          const metrics = [
            { label: '누적 수익률',   val: fmtR(tradeSimResult.totalReturn),  color: tradeSimResult.totalReturn >= 0 ? green : red },
            { label: '연환산 수익률', val: fmtR(tradeSimResult.annReturn),     color: tradeSimResult.annReturn   >= 0 ? green : red },
            {
              label: 'vs KOSPI200',
              val: tradeSimResult.benchKospi != null ? fmtR(tradeSimResult.totalReturn - tradeSimResult.benchKospi) : '-',
              color: tradeSimResult.benchKospi != null ? (tradeSimResult.totalReturn >= tradeSimResult.benchKospi ? green : red) : gray,
            },
            {
              label: 'vs KOSDAQ150',
              val: tradeSimResult.benchKosdaq != null ? fmtR(tradeSimResult.totalReturn - tradeSimResult.benchKosdaq) : '-',
              color: tradeSimResult.benchKosdaq != null ? (tradeSimResult.totalReturn >= tradeSimResult.benchKosdaq ? green : red) : gray,
            },
            { label: 'MDD',       val: `-${tradeSimResult.maxDrawdown.toFixed(2)}%`, color: red },
            { label: '주간 승률', val: `${tradeSimResult.winRate.toFixed(1)}%`,       color: tradeSimResult.winRate >= 50 ? green : red },
            { label: '보유 기간', val: `${tradeSimResult.holdWeeks}주`,               color: gray },
            { label: '현금 기간', val: `${tradeSimResult.cashWeeks}주`,               color: gray },
          ]
          return (
            <div>
              <div style={{
                marginBottom: 16, padding: '12px 16px', borderRadius: 8,
                border: `1px solid ${tradeSimResult.currentHolding ? '#1f6feb' : '#30363d'}`,
                background: tradeSimResult.currentHolding ? '#0d1f3c' : '#161b22',
              }}>
                <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6 }}>
                  현재 포지션 ({tradeSimResult.currentWeek})
                </div>
                {tradeSimResult.currentHolding ? (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span style={{ fontSize: 12, color: '#3fb950', fontWeight: 600 }}>● 보유 중</span>
                    {tradeSimResult.currentHolding.map(s => (
                      <span key={s} style={{
                        padding: '2px 10px', borderRadius: 12, fontSize: 12,
                        background: `${SECTOR_COLORS[s] ?? '#6b7280'}22`,
                        color: SECTOR_COLORS[s] ?? '#e6edf3',
                        border: `1px solid ${SECTOR_COLORS[s] ?? '#6b7280'}44`,
                      }}>
                        {SECTOR_LABELS[s] ?? s}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize: 13, color: '#f85149', fontWeight: 600 }}>● 현금 (2주 연속 언급 감소로 매도)</div>
                )}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 20 }}>
                {metrics.map(m => (
                  <div key={m.label} style={{ background: '#0d1117', borderRadius: 8, padding: '10px 14px', border: '1px solid #21262d' }}>
                    <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>{m.label}</div>
                    <div style={{ fontSize: 15, fontWeight: 600, color: m.color }}>{m.val}</div>
                  </div>
                ))}
              </div>

              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 8 }}>누적 수익률 추이 (기준: 100)</div>
                <ResponsiveContainer width="100%" height={280}>
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
                    <Line type="monotone" dataKey="strat"    name="전략"      stroke="#3B82F6" dot={false} strokeWidth={2}   connectNulls />
                    <Line type="monotone" dataKey="kospi200"  name="KOSPI200"  stroke="#f59e0b" dot={false} strokeWidth={1.5} connectNulls strokeDasharray="5 3" />
                    <Line type="monotone" dataKey="kosdaq150" name="KOSDAQ150" stroke="#a855f7" dot={false} strokeWidth={1.5} connectNulls strokeDasharray="5 3" />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              <details>
                <summary style={{ fontSize: 12, color: '#6b7280', cursor: 'pointer', userSelect: 'none', marginBottom: 4 }}>
                  매매 로그 ({tradeSimResult.nBuys}회 매수 / {tradeSimResult.nSells}회 매도)
                </summary>
                <div style={{ marginTop: 8, maxHeight: 200, overflowY: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                    <thead>
                      <tr style={{ color: '#6b7280', borderBottom: '1px solid #21262d' }}>
                        <th style={{ textAlign: 'left', padding: '4px 8px' }}>주차</th>
                        <th style={{ textAlign: 'left', padding: '4px 8px' }}>액션</th>
                        <th style={{ textAlign: 'left', padding: '4px 8px' }}>섹터</th>
                        <th style={{ textAlign: 'left', padding: '4px 8px' }}>사유</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...tradeSimResult.tradeLog].reverse().map((t, i) => {
                        const isOpenBuy = i === 0 && tradeSimResult.currentHolding !== null
                        return (
                          <tr key={i} style={{ borderBottom: '1px solid #161b22', background: isOpenBuy ? '#0d1f3c' : 'transparent' }}>
                            <td style={{ padding: '4px 8px', color: '#8b949e' }}>{t.week}</td>
                            <td style={{ padding: '4px 8px', fontWeight: 600, color: t.action === 'BUY' ? green : red }}>
                              {t.action === 'BUY' ? '매수' : '매도'}
                              {isOpenBuy && <span style={{ marginLeft: 6, fontSize: 10, color: '#3fb950', border: '1px solid #3fb95044', borderRadius: 4, padding: '1px 5px' }}>보유중</span>}
                            </td>
                            <td style={{ padding: '4px 8px', color: '#e6edf3' }}>
                              {t.sectors.map(s => SECTOR_LABELS[s] ?? s).join(', ')}
                            </td>
                            <td style={{ padding: '4px 8px', color: '#6b7280', fontSize: 10 }}>
                              {t.reason ?? ''}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </details>
            </div>
          )
        })()}
      </div>

      {/* 전략 최적화 */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <div style={{ color: '#e6edf3', fontSize: 14, fontWeight: 600 }}>전략 최적화</div>
          <div style={{ fontSize: 11, color: '#6b7280' }}>
            TOP N × 청산 기준(보유δ/시장δ) × 연속 하락 N주 × 청산 후 행동 — {3 * 2 * 3 * 2}가지 조합
          </div>
          <button
            onClick={runOptimization}
            disabled={optRunning || activeRows.length === 0}
            style={{
              marginLeft: 'auto', padding: '5px 14px', borderRadius: 6,
              border: '1px solid #30363d',
              background: optRunning ? '#21262d' : '#7c3aed',
              color: '#fff', cursor: optRunning ? 'not-allowed' : 'pointer', fontSize: 12,
            }}
          >
            {optRunning ? '탐색 중...' : '최적 전략 탐색'}
          </button>
        </div>

        {optResults.length > 0 && (() => {
          const fmtR = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`
          const cols: { key: keyof OptResult; label: string }[] = [
            { key: 'totalReturn',  label: '누적수익' },
            { key: 'annReturn',    label: '연환산'   },
            { key: 'winRate',      label: '승률'     },
            { key: 'maxDrawdown',  label: 'MDD'      },
            { key: 'holdWeeks',    label: '보유주'   },
            { key: 'cashWeeks',    label: '현금주'   },
            { key: 'nTrades',      label: '거래수'   },
          ]
          const sorted = [...optResults].sort((a, b) =>
            (b[optSortKey] as number) - (a[optSortKey] as number)
          )
          const best = sorted[0]
          return (
            <div style={{ overflowX: 'auto' }}>
              <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 8 }}>
                컬럼 클릭 시 정렬 · 상위 전략을 시나리오에 직접 적용해보세요
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ color: '#6b7280', borderBottom: '1px solid #21262d' }}>
                    <th style={{ textAlign: 'left', padding: '5px 8px' }}>#</th>
                    <th style={{ textAlign: 'left', padding: '5px 8px' }}>전략 조합</th>
                    {cols.map(c => (
                      <th
                        key={c.key}
                        onClick={() => setOptSortKey(c.key)}
                        style={{
                          textAlign: 'right', padding: '5px 8px', cursor: 'pointer',
                          color: optSortKey === c.key ? '#a78bfa' : '#6b7280',
                          userSelect: 'none',
                        }}
                      >
                        {c.label}{optSortKey === c.key ? ' ▼' : ''}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r, i) => {
                    const isBest = r.label === best.label
                    return (
                      <tr key={r.label} style={{
                        borderBottom: '1px solid #161b22',
                        background: isBest ? '#1a1a3a' : i < 3 ? '#0d1117' : 'transparent',
                      }}>
                        <td style={{ padding: '5px 8px', color: i === 0 ? '#f59e0b' : '#6b7280', fontWeight: i === 0 ? 700 : 400 }}>
                          {i === 0 ? '★' : i + 1}
                        </td>
                        <td style={{ padding: '5px 8px', color: isBest ? '#a78bfa' : '#e6edf3', fontWeight: isBest ? 600 : 400 }}>
                          {r.label}
                        </td>
                        <td style={{ padding: '5px 8px', textAlign: 'right', color: r.totalReturn >= 0 ? green : red, fontWeight: isBest ? 700 : 400 }}>
                          {fmtR(r.totalReturn)}
                        </td>
                        <td style={{ padding: '5px 8px', textAlign: 'right', color: r.annReturn >= 0 ? green : red }}>
                          {fmtR(r.annReturn)}
                        </td>
                        <td style={{ padding: '5px 8px', textAlign: 'right', color: r.winRate >= 50 ? green : red }}>
                          {r.winRate.toFixed(1)}%
                        </td>
                        <td style={{ padding: '5px 8px', textAlign: 'right', color: red }}>
                          -{r.maxDrawdown.toFixed(1)}%
                        </td>
                        <td style={{ padding: '5px 8px', textAlign: 'right', color: gray }}>{r.holdWeeks}</td>
                        <td style={{ padding: '5px 8px', textAlign: 'right', color: gray }}>{r.cashWeeks}</td>
                        <td style={{ padding: '5px 8px', textAlign: 'right', color: gray }}>{r.nTrades}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )
        })()}
      </div>

      {/* 특정종목 시뮬레이션 */}
      <div style={{ marginTop: 40, borderTop: '1px solid #21262d', paddingTop: 28 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#e6edf3', marginBottom: 4 }}>특정종목 시뮬레이션</div>
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 16 }}>
          종목을 검색해 52주 언급량 트렌드와 섹터 수익률을 기반으로 추천 여부를 판단합니다.
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
              {stockSimLoading ? '분석 중...' : '시뮬레이션 실행'}
            </button>
          </div>
        )}

        {/* 결과 카드 */}
        {stockSimResult && (() => {
          const r = stockSimResult
          const streakLabel = r.streak === 0
            ? '보합'
            : r.streak > 0
              ? `${r.streak}주 연속 상승 중`
              : `${Math.abs(r.streak)}주 연속 하락 중`
          const streakColor = r.streak > 0 ? green : r.streak < 0 ? red : gray
          const ytdPct = ((r.ytdMultiplier - 1) * 100).toFixed(1)
          const ytdColor = r.ytdMultiplier >= 1 ? green : red
          const comparisons = r.rollingWindow - 1
          const upRate = comparisons > 0 ? r.upWeeks / comparisons : 0
          const scoreItems = [
            {
              label: `상승 비율 ≥ 50% (${r.rollingWindow}주 롤링)`,
              desc: `실제 ${(upRate * 100).toFixed(1)}% (${r.upWeeks}/${comparisons}번)`,
              pts: upRate >= 1 / 2 ? 2 : 0,
              max: 2,
              met: upRate >= 1 / 2,
            },
            {
              label: `상승 비율 ≥ 40% (${r.rollingWindow}주 롤링)`,
              desc: `실제 ${(upRate * 100).toFixed(1)}% (${r.upWeeks}/${comparisons}번)`,
              pts: upRate >= 2 / 5 && upRate < 1 / 2 ? 1 : 0,
              max: 1,
              met: upRate >= 2 / 5,
            },
            {
              label: `연속 상승 ≥ 3주 (${r.rollingWindow}주 롤링)`,
              desc: `실제 ${r.streak > 0 ? r.streak : 0}주 연속`,
              pts: r.streak >= 3 ? 2 : 0,
              max: 2,
              met: r.streak >= 3,
            },
            {
              label: `연속 상승 ≥ 2주 (${r.rollingWindow}주 롤링)`,
              desc: `실제 ${r.streak > 0 ? r.streak : 0}주 연속`,
              pts: r.streak >= 2 && r.streak < 3 ? 1 : 0,
              max: 1,
              met: r.streak >= 2,
            },
            {
              label: '연초 대비 섹터 ≥ 1.10배',
              desc: `실제 ${r.ytdMultiplier.toFixed(2)}배`,
              pts: r.ytdMultiplier >= 1.1 ? 1 : 0,
              max: 1,
              met: r.ytdMultiplier >= 1.1,
            },
          ]
          return (
            <div style={{
              marginTop: 20, borderRadius: 12,
              border: '1px solid #21262d', background: '#0d1117',
              display: 'flex', gap: 0,
            }}>
              {/* 좌: 차트 + 지표 + 결론 */}
              <div style={{ flex: 1, padding: '20px 24px', minWidth: 0 }}>
                {/* 헤더 */}
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#e6edf3' }}>
                    {selectedStock!.name}
                    <span style={{ fontSize: 12, color: '#6b7280', marginLeft: 8 }}>({selectedStock!.ticker})</span>
                  </div>
                  <div style={{ fontSize: 12, color: '#a78bfa', marginTop: 3 }}>
                    섹터: {r.sectorLabel}
                  </div>
                </div>

                {/* 52주 언급량 바 차트 */}
                <div style={{ marginBottom: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <span style={{ fontSize: 12, color: '#6b7280' }}>52주 언급량 추이 (차트)</span>
                    <span style={{ fontSize: 12 }}>
                      <span style={{ color: '#6b7280', fontSize: 11 }}>{r.rollingWindow}주 롤링 기준 · </span>
                      <span style={{ color: green }}>{r.upWeeks}주 상승</span>
                      <span style={{ color: '#6b7280' }}> / </span>
                      <span style={{ color: red }}>{r.downWeeks}주 하락</span>
                      <span style={{ color: '#6b7280', marginLeft: 6 }}>· 연속: </span>
                      <span style={{ color: streakColor, fontWeight: 600 }}>{streakLabel}</span>
                    </span>
                  </div>
                  {(() => {
                    const chartData = r.weeklyMentions.map((count, i) => {
                      const prev = i === 0 ? count : r.weeklyMentions[i - 1]
                      const dir = i === 0 ? 'flat' : count > prev ? 'up' : count < prev ? 'down' : 'flat'
                      const label = r.weekDates[i].slice(5).replace('-', '/')
                      return { label, count, dir }
                    })
                    const maxCount = Math.max(...chartData.map(d => d.count), 1)
                    return (
                      <ResponsiveContainer width="100%" height={130}>
                        <BarChart data={chartData} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}
                          barCategoryGap="20%">
                          <CartesianGrid vertical={false} stroke="#21262d" />
                          <XAxis dataKey="label" tick={{ fontSize: 9, fill: '#6b7280' }} axisLine={false} tickLine={false} interval={7} />
                          <YAxis tick={{ fontSize: 10, fill: '#6b7280' }} axisLine={false} tickLine={false} domain={[0, maxCount]} />
                          <Tooltip
                            cursor={{ fill: '#ffffff08' }}
                            contentStyle={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 6, fontSize: 12 }}
                            labelStyle={{ color: '#6b7280' }}
                            formatter={(value, _name, entry) => {
                              const dir = (entry as { payload: { dir: string } }).payload.dir
                              const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '─'
                              return [`${value ?? 0}건 ${arrow}`, '언급량']
                            }}
                          />
                          <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                            {chartData.map((d, i) => (
                              <Cell
                                key={i}
                                fill={d.dir === 'up' ? '#3fb950' : d.dir === 'down' ? '#f85149' : '#4b5563'}
                              />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    )
                  })()}
                </div>

                {/* 지표 */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13, borderTop: '1px solid #21262d', paddingTop: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: '#6b7280' }}>연초 대비 섹터 수익률</span>
                    <span style={{ color: ytdColor, fontWeight: 600 }}>
                      {r.ytdMultiplier.toFixed(2)}배 ({ytdPct}%)
                    </span>
                  </div>
                </div>

                {/* 결론 */}
                <div style={{
                  marginTop: 18, padding: '14px 18px', borderRadius: 10,
                  background: r.recommend ? '#064e3b' : '#450a0a',
                  border: `1px solid ${r.recommend ? '#34d399' : '#f87171'}`,
                  display: 'flex', alignItems: 'center', gap: 10,
                }}>
                  <span style={{ fontSize: 22 }}>{r.recommend ? '✅' : '❌'}</span>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: r.recommend ? green : red }}>
                      {r.recommend ? '추천합니다' : '추천하지 않습니다'}
                    </div>
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                      {r.recommend
                        ? `복합 기준 3점 이상 충족 (${r.score}/5점)`
                        : `복합 기준 3점 미달 (${r.score}/5점)`}
                    </div>
                  </div>
                </div>
              </div>

              {/* 우: 점수 선정기준 */}
              <div style={{
                width: 220, flexShrink: 0,
                borderLeft: '1px solid #21262d',
                padding: '20px 18px',
                display: 'flex', flexDirection: 'column', gap: 0,
              }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', marginBottom: 12 }}>점수 선정기준</div>
                {scoreItems.map((item, i) => (
                  <div key={i} style={{
                    padding: '8px 0',
                    borderBottom: i < scoreItems.length - 1 ? '1px solid #161b22' : 'none',
                    opacity: item.met ? 1 : 0.45,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
                      <span style={{ fontSize: 11, color: item.met ? '#e6edf3' : '#6b7280' }}>{item.label}</span>
                      <span style={{
                        fontSize: 11, fontWeight: 700,
                        color: item.pts > 0 ? green : '#4b5563',
                      }}>
                        {item.pts > 0 ? `+${item.pts}점` : `0/${item.max}점`}
                      </span>
                    </div>
                    <div style={{ fontSize: 10, color: '#6b7280' }}>{item.desc}</div>
                  </div>
                ))}
                <div style={{
                  marginTop: 14, paddingTop: 12, borderTop: '1px solid #21262d',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}>
                  <span style={{ fontSize: 12, color: '#6b7280' }}>합계</span>
                  <span style={{
                    fontSize: 14, fontWeight: 700,
                    color: r.score >= 3 ? green : red,
                  }}>
                    {r.score} / 5점
                  </span>
                </div>
                <div style={{ marginTop: 6, fontSize: 10, color: '#4b5563', textAlign: 'right' }}>
                  3점 이상 → 추천
                </div>
              </div>
            </div>
          )
        })()}
      </div>
    </div>
  )
}

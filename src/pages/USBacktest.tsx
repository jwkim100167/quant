import { useEffect, useState, useMemo, useCallback } from 'react'
import {
  LineChart, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, ReferenceLine, Legend,
} from 'recharts'
import { supabase } from '../lib/supabase'
import {
  SECTOR_LABELS, SECTOR_COLORS,
  type BacktestRow, type SectorReturn,
} from '../types'

const US_SECTORS = ['NASDAQ_TOP10']
const US_TICKERS = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AVGO', 'COST', 'NFLX']

const ROLLING_WINDOW_OPTIONS = [
  { label: '4주',        value: 4  },
  { label: '8주',        value: 8  },
  { label: '13주 (분기)', value: 13 },
  { label: '26주 (반기)', value: 26 },
]

type TradeScenario = 'top1_track' | 'market_signal_3w' | 'market_signal_2w' | 'hybrid_optimal' | 'rank_signal'
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
  {
    key: 'rank_signal',
    label: '순위 상승 or Top3 진입',
    desc: '개별 종목 언급 순위 기반 QQQ 매매.\n· Top3 종목 중 하나라도 순위가 올라가거나 언급량이 증가하면 매수\n· 신호 소멸 시 전량 매도 → 현금\n· 수익률 프록시: NASDAQ_TOP10 (QQQ)',
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

export default function USBacktest() {
  const [rawStats, setRawStats]     = useState<RawStat[]>([])
  const [rawReturns, setRawReturns] = useState<SectorReturn[]>([])
  const [loading, setLoading]       = useState(true)
  const [rollingWeeks, setRollingWeeks] = useState(13)
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('report')
  const [tradeScenario, setTradeScenario]     = useState<TradeScenario>('hybrid_optimal')
  const [hoveredScenario, setHoveredScenario] = useState<TradeScenario | null>(null)
  const [benchmarks, setBenchmarks] = useState<Record<string, { kospi200: number | null; kosdaq150: number | null }>>({})
  const [tickerWeekly, setTickerWeekly] = useState<Record<string, Record<string, number>>>({})

  useEffect(() => {
    async function load() {
      setLoading(true)

      const stats: RawStat[] = []
      let offset = 0
      while (true) {
        const { data } = await supabase
          .from('weekly_sector_stats')
          .select('week_start,sector_id,mention_count,positive_count,report_count,community_count')
          .in('sector_id', US_SECTORS)
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
          .in('sector_id', US_SECTORS)
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

      // Load ticker-level weekly mention counts for rank signal scenario
      const mentionFrom = new Date()
      mentionFrom.setDate(mentionFrom.getDate() - 52 * 7 * 2)
      const mentionFromStr = mentionFrom.toISOString().split('T')[0]
      const allMentions: { ticker: string; mentioned_at: string }[] = []
      let mOffset = 0
      while (true) {
        const { data: mData } = await supabase
          .from('raw_mentions')
          .select('ticker, mentioned_at')
          .in('ticker', US_TICKERS)
          .gte('mentioned_at', mentionFromStr)
          .range(mOffset, mOffset + 999)
        if (!mData || mData.length === 0) break
        allMentions.push(...(mData as typeof allMentions))
        if (mData.length < 1000) break
        mOffset += 1000
      }
      const weekTicker: Record<string, Record<string, number>> = {}
      allMentions.forEach(m => {
        const d = new Date(m.mentioned_at)
        const day = d.getDay()
        const diff = day === 0 ? -6 : 1 - day
        const mon = new Date(d)
        mon.setDate(d.getDate() + diff)
        const w = mon.toISOString().split('T')[0]
        if (!weekTicker[w]) weekTicker[w] = {}
        weekTicker[w][m.ticker] = (weekTicker[w][m.ticker] ?? 0) + 1
      })
      setTickerWeekly(weekTicker)

      setLoading(false)
    }
    load()
  }, [])

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
      const annFactor = 52

      // === RANK SIGNAL scenario: ticker-level rank from raw_mentions ===
      if (tradeScenario === 'rank_signal') {
        const qqqReturnMap: Record<string, number> = {}
        for (const r of rawReturns) {
          if (r.sector_id === 'NASDAQ_TOP10') {
            qqqReturnMap[String(r.week_start).slice(0, 10)] = r.return_pct
          }
        }

        const now = new Date()
        const daysToMon = (now.getDay() + 6) % 7
        const thisMon = new Date(now)
        thisMon.setDate(now.getDate() - daysToMon)
        thisMon.setHours(0, 0, 0, 0)
        const thisMonStr = thisMon.toISOString().slice(0, 10)
        const allTickerWeeks = Object.keys(tickerWeekly).filter(w => w < thisMonStr).sort()

        let isRankHolding = false
        let cumStrat = 100, cumKospi = 100, cumKosdaq = 100
        let peak = 100, maxDD = 0
        let holdWeeks = 0, cashWeeks = 0, wins = 0
        let hasBenchKospi = false, hasBenchKosdaq = false
        const series: TradeSimResult['series'] = []
        const rankTradeLog: TradeLog[] = []

        for (let i = 1; i < allTickerWeeks.length - 1; i++) {
          const wKey     = allTickerWeeks[i]
          const prevWKey = allTickerWeeks[i - 1]
          const nextWKey = allTickerWeeks[i + 1]
          const curCounts  = tickerWeekly[wKey]     ?? {}
          const prevCounts = tickerWeekly[prevWKey] ?? {}

          const sorted     = [...US_TICKERS].sort((a, b) => (curCounts[b]  ?? 0) - (curCounts[a]  ?? 0))
          const prevSorted = [...US_TICKERS].sort((a, b) => (prevCounts[b] ?? 0) - (prevCounts[a] ?? 0))
          const ranks: Record<string, number>     = {}
          const prevRanks: Record<string, number> = {}
          sorted.forEach((t, idx)     => { ranks[t]     = idx + 1 })
          prevSorted.forEach((t, idx) => { prevRanks[t] = idx + 1 })

          // Signal: any top-3 ticker's rank improved OR mention count grew
          const signal = US_TICKERS.some(t =>
            ranks[t] <= 3 && (ranks[t] < prevRanks[t] || (curCounts[t] ?? 0) > (prevCounts[t] ?? 0))
          )

          const nextReturn = qqqReturnMap[nextWKey] ?? 0
          const bench = activeBenchmarks[nextWKey]

          if (signal) {
            if (!isRankHolding) {
              rankTradeLog.push({ week: wKey, action: 'BUY', sectors: ['NASDAQ_TOP10'], reason: 'Top3 순위 상승/성장' })
              isRankHolding = true
            }
            cumStrat *= (1 + nextReturn / 100)
            holdWeeks++
            if (nextReturn > 0) wins++
          } else {
            if (isRankHolding) {
              rankTradeLog.push({ week: wKey, action: 'SELL', sectors: ['NASDAQ_TOP10'], reason: '순위 신호 소멸' })
              isRankHolding = false
            }
            cashWeeks++
          }

          if (bench?.kospi200  != null) { cumKospi  *= (1 + bench.kospi200  / 100); hasBenchKospi  = true }
          if (bench?.kosdaq150 != null) { cumKosdaq *= (1 + bench.kosdaq150 / 100); hasBenchKosdaq = true }
          if (cumStrat > peak) peak = cumStrat
          const dd = (peak - cumStrat) / peak * 100
          if (dd > maxDD) maxDD = dd

          series.push({
            week:      wKey,
            strat:     parseFloat(cumStrat.toFixed(2)),
            kospi200:  bench?.kospi200  != null ? parseFloat(cumKospi.toFixed(2))  : null,
            kosdaq150: bench?.kosdaq150 != null ? parseFloat(cumKosdaq.toFixed(2)) : null,
          })
        }

        const nPeriods    = allTickerWeeks.length
        const totalReturn = cumStrat - 100
        const annReturn   = nPeriods > 0 ? (Math.pow(cumStrat / 100, annFactor / nPeriods) - 1) * 100 : 0

        setTradeSimResult({
          series, totalReturn, annReturn,
          maxDrawdown: maxDD,
          winRate:   holdWeeks > 0 ? wins / holdWeeks * 100 : 0,
          nBuys:     rankTradeLog.filter(t => t.action === 'BUY').length,
          nSells:    rankTradeLog.filter(t => t.action === 'SELL').length,
          holdWeeks, cashWeeks,
          benchKospi:  hasBenchKospi  ? cumKospi  - 100 : null,
          benchKosdaq: hasBenchKosdaq ? cumKosdaq - 100 : null,
          tradeLog:       rankTradeLog,
          currentHolding: isRankHolding ? ['NASDAQ_TOP10'] : null,
          currentWeek:    allTickerWeeks[allTickerWeeks.length - 1] ?? null,
        })
        setTradeSimRunning(false)
        return
      }
      // === END RANK SIGNAL ===

      const allPeriodKeys = [...new Set(activeRows.map(r => String(r.week_start).slice(0, 10)))].sort()

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
  }, [activeRows, activeBenchmarks, tradeScenario, tickerWeekly, rawReturns])

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

  if (loading) return <div className="loading">데이터 불러오는 중...</div>

  const green = '#3fb950', red = '#f85149', gray = '#8b949e'

  return (
    <div>
      <div className="page-header">
        <div className="page-title">미국 백테스트</div>
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
            버튼을 눌러 실제 매매 시뮬레이션을 시작합니다.
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
                  <div style={{ fontSize: 13, color: '#f85149', fontWeight: 600 }}>● 현금 (언급 감소로 매도)</div>
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
    </div>
  )
}

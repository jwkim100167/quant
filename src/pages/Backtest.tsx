import { useEffect, useState, useMemo, useCallback } from 'react'
import {
  ScatterChart, Scatter, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, ReferenceLine, Cell,
  LineChart, Line, Legend,
} from 'recharts'
import { supabase } from '../lib/supabase'
import {
  SECTOR_LABELS, SECTOR_COLORS,
  type BacktestRow, type SectorReturn,
} from '../types'

interface StockStat {
  ticker:         string
  name:           string
  mention_count:  number
  positive_count: number
  negative_count: number
  net_sentiment:  number
}

const ROLLING_PERIODS = [
  { label: '13주',   weeks: 13  },
  { label: '26주',   weeks: 26  },
  { label: '52주',   weeks: 52  },
  { label: '전체',   weeks: 999 },
]
const ROLLING_WINDOW_OPTIONS = [
  { label: '4주',   value: 4  },
  { label: '8주',   value: 8  },
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

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length
  if (n < 2) return 0
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  const num = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0)
  const den = Math.sqrt(
    xs.reduce((s, x) => s + (x - mx) ** 2, 0) *
    ys.reduce((s, y) => s + (y - my) ** 2, 0)
  )
  return den === 0 ? 0 : num / den
}

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
  const [rawStats, setRawStats]   = useState<RawStat[]>([])
  const [rawReturns, setRawReturns] = useState<SectorReturn[]>([])
  const [loading, setLoading] = useState(true)
  const [period, setPeriod]             = useState(52)
  const [rollingWeeks, setRollingWeeks] = useState(13)
  const [topN, setTopN]                       = useState(1)
  const [tradeScenario, setTradeScenario]     = useState<TradeScenario>('hybrid_optimal')
  const [hoveredScenario, setHoveredScenario] = useState<TradeScenario | null>(null)
  const [signal, setSignal]                   = useState<'mention' | 'positive'>('mention')
  const [sourceFilter, setSourceFilter]       = useState<SourceFilter>('report')
  const [benchmarks, setBenchmarks] = useState<Record<string, { kospi200: number | null; kosdaq150: number | null }>>({})

  useEffect(() => {
    async function load() {
      setLoading(true)

      // 1) weekly_sector_stats 전체 조회 (소스별 카운트 포함)
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

      // 2) weekly_sector_returns 전체 조회
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

      // 7) weekly_benchmark_returns 조회
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
  // mention_delta = 현재 N주 합계 - 이전 N주 합계 (매주 업데이트)
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
    // 현재 N주 [i-N+1..i] 와 이전 N주 [i-2N+1..i-N] 비교 → 2N-1 부터 시작
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

  // ── 월간 집계 ──────────────────────────────────────────────
  const monthlyRows = useMemo(() => {
    if (rows.length === 0) return []
    const gm = (d: string) => String(d).slice(0, 7)

    // 월별 언급 합계
    const mCnt: Record<string, Record<string, number>> = {}
    const mPos: Record<string, Record<string, number>> = {}
    for (const r of rows) {
      const m = gm(r.week_start)
      if (!mCnt[m]) { mCnt[m] = {}; mPos[m] = {} }
      mCnt[m][r.sector_id] = (mCnt[m][r.sector_id] ?? 0) + r.mention_count
      mPos[m][r.sector_id] = (mPos[m][r.sector_id] ?? 0) + r.positive_count
    }

    // 월별 복합 수익률 (return_week 기준 월로 그룹)
    const mRet: Record<string, Record<string, number>> = {}
    for (const r of rows) {
      if (r.next_week_return === null) continue
      const m = gm(String(r.return_week))
      if (!mRet[m]) mRet[m] = {}
      if (mRet[m][r.sector_id] === undefined) mRet[m][r.sector_id] = 1
      mRet[m][r.sector_id] *= (1 + r.next_week_return / 100)
    }
    for (const m of Object.keys(mRet))
      for (const sid of Object.keys(mRet[m]))
        mRet[m][sid] = (mRet[m][sid] - 1) * 100

    const months = [...new Set(Object.keys(mCnt))].sort()
    const result: BacktestRow[] = []
    for (let i = 1; i < months.length - 1; i++) {
      const prev = months[i - 1]; const cur = months[i]; const next = months[i + 1]
      const cc = mCnt[cur] ?? {}; const pc = mCnt[prev] ?? {}
      const cp = mPos[cur] ?? {}; const pp = mPos[prev] ?? {}
      const nr = mRet[next] ?? {}
      for (const [sid, count] of Object.entries(cc)) {
        result.push({
          week_start:       cur,
          return_week:      next,
          sector_id:        sid,
          mention_delta:    count - (pc[sid] ?? 0),
          positive_delta:   (cp[sid] ?? 0) - (pp[sid] ?? 0),
          mention_count:    count,
          positive_count:   cp[sid] ?? 0,
          next_week_return: nr[sid] ?? null,
        })
      }
    }
    return result
  }, [rows])

  // 월간 벤치마크 (주간 수익률 합산)
  const monthlyBenchmarks = useMemo(() => {
    const gm = (d: string) => String(d).slice(0, 7)
    const mm: Record<string, { k200: number; k150: number; n: number }> = {}
    for (const [week, b] of Object.entries(benchmarks)) {
      const m = gm(week)
      if (!mm[m]) mm[m] = { k200: 0, k150: 0, n: 0 }
      if (b.kospi200  != null) mm[m].k200 += b.kospi200
      if (b.kosdaq150 != null) mm[m].k150 += b.kosdaq150
      mm[m].n++
    }
    const result: Record<string, { kospi200: number | null; kosdaq150: number | null }> = {}
    for (const [m, v] of Object.entries(mm))
      result[m] = { kospi200: v.n > 0 ? v.k200 : null, kosdaq150: v.n > 0 ? v.k150 : null }
    return result
  }, [benchmarks])

  const activeRows       = rollingRows
  const activeBenchmarks = benchmarks
  const periodOptions    = ROLLING_PERIODS
  const periodUnit       = '주'

  // 신호 선택에 따른 delta 반환
  const getDelta = useCallback(
    (r: BacktestRow) => signal === 'positive' ? r.positive_delta : r.mention_delta,
    [signal]
  )

  // 기간 필터 — 수익률 데이터가 있는 기간 기준 최근 N
  const filtered = useMemo(() => {
    if (activeRows.length === 0) return []
    const periodsWithData = [...new Set(
      activeRows.filter(r => r.next_week_return !== null).map(r => r.week_start)
    )].sort().reverse()
    const cutPeriods = new Set(periodsWithData.slice(0, period))
    return activeRows.filter(r => cutPeriods.has(r.week_start) && r.next_week_return !== null)
  }, [activeRows, period])

  // 매 기간 TOP N 섹터만 추출
  const topNFiltered = useMemo(() => {
    const periods = [...new Set(filtered.map(r => r.week_start))]
    const result: typeof filtered = []
    for (const w of periods) {
      const wRows = [...filtered.filter(r => r.week_start === w)]
      wRows.sort((a, b) => getDelta(b) - getDelta(a))
      result.push(...wRows.slice(0, topN))
    }
    return result
  }, [filtered, getDelta, topN])

  // TOP 1~topN 각 랭크별 평균 수익률
  const rankAvgs = useMemo(() => {
    const periods = [...new Set(filtered.map(r => r.week_start))]
    const rets = Array.from({ length: topN }, () => [] as number[])
    for (const w of periods) {
      const sorted = [...filtered.filter(r => r.week_start === w)].sort((a, b) => getDelta(b) - getDelta(a))
      for (let i = 0; i < topN; i++) {
        const row = sorted[i]
        if (row?.next_week_return != null) rets[i].push(row.next_week_return)
      }
    }
    return rets.map(r => r.length > 0 ? r.reduce((a, b) => a + b, 0) / r.length : null)
  }, [filtered, getDelta, topN])

  // 상관계수 (top3 기준)
  const correlation = useMemo(() => {
    if (topNFiltered.length < 5) return null
    return pearson(topNFiltered.map(r => getDelta(r)), topNFiltered.map(r => r.next_week_return!))
  }, [topNFiltered, getDelta])

  // 섹터별 집계
  const sectorSummary = useMemo(() => {
    const map: Record<string, { returns: number[]; deltas: number[] }> = {}
    for (const r of topNFiltered) {
      if (!map[r.sector_id]) map[r.sector_id] = { returns: [], deltas: [] }
      map[r.sector_id].returns.push(r.next_week_return!)
      map[r.sector_id].deltas.push(getDelta(r))
    }
    return Object.entries(map)
      .map(([sid, { returns, deltas }]) => ({
        sector_id:  sid,
        avg_return: returns.reduce((a, b) => a + b, 0) / returns.length,
        win_rate:   returns.filter(r => r > 0).length / returns.length * 100,
        avg_delta:  deltas.reduce((a, b) => a + b, 0) / deltas.length,
        count:      returns.length,
      }))
      .sort((a, b) => b.avg_delta - a.avg_delta)
  }, [topNFiltered, getDelta])

  // 산점도용 데이터
  const scatterData = useMemo(() =>
    topNFiltered.map(r => ({
      x:   getDelta(r),
      y:   r.next_week_return!,
      sid: r.sector_id,
      rank: [...filtered.filter(f => f.week_start === r.week_start)]
        .sort((a, b) => getDelta(b) - getDelta(a))
        .findIndex(f => f.sector_id === r.sector_id) + 1,
    })),
    [topNFiltered, filtered, getDelta]
  )

  // ── 순열 검정 ──────────────────────────────────────────────
  interface RankResult {
    rank:         number
    topNMean:     number
    excessKospi:  number | null
    excessKosdaq: number | null
    excessRandom: number
    kospiPValue:  number | null
    kosdaqPValue: number | null
    randomPValue: number
  }
  interface SimResult {
    rankResults:   RankResult[]
    corrObs:       number
    corrPValue:    number
    kospi200Mean:  number | null
    kosdaq150Mean: number | null
    weekAvgMean:   number
    hasBenchmark:  boolean
    nPerms:        number
    nWeeks:        number
  }
  const [simResult, setSimResult]   = useState<SimResult | null>(null)
  const [simRunning, setSimRunning] = useState(false)

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
  const [tradeSimResult, setTradeSimResult] = useState<TradeSimResult | null>(null)
  const [tradeSimRunning, setTradeSimRunning] = useState(false)

  // ── 전략 최적화 ──────────────────────────────────────────────
  interface OptResult {
    label:       string
    topN:        number
    exitTrigger: string   // 'held_delta' | 'market_delta'
    declineN:    number   // 연속 하락 N주 후 매도
    afterSell:   string   // 'cash' | 'count_top'
    totalReturn: number
    annReturn:   number
    winRate:     number
    maxDrawdown: number
    holdWeeks:   number
    cashWeeks:   number
    nTrades:     number
  }
  const [optResults, setOptResults]   = useState<OptResult[]>([])
  const [optRunning, setOptRunning]   = useState(false)
  const [optSortKey, setOptSortKey]   = useState<keyof OptResult>('totalReturn')

  const runSimulation = useCallback(() => {
    setSimRunning(true)
    setSimResult(null)

    setTimeout(() => {
      const N_PERMS = 3000
      const RANKS   = Array.from({ length: topN }, (_, i) => i + 1)
      const periodKeys = [...new Set(filtered.map(r => r.week_start))]

      const xs = topNFiltered.map(r => r.mention_delta)
      const ys = topNFiltered.map(r => r.next_week_return!)
      const corrObs = pearson(xs, ys)

      const weeklyReturns = periodKeys.map(w =>
        [...filtered.filter(r => r.week_start === w)]
          .sort((a, b) => getDelta(b) - getDelta(a))
          .map(r => r.next_week_return!)
      ).filter(d => d.length > 0)

      const weekAvgMean = weeklyReturns.reduce(
        (s, d) => s + d.reduce((a, b) => a + b, 0) / d.length, 0
      ) / weeklyReturns.length

      const returnWeekMap: Record<string, string> = {}
      for (const r of filtered) {
        returnWeekMap[String(r.week_start).slice(0, 10)] = String(r.return_week).slice(0, 10)
      }

      const rankKospiDiffs:  number[][] = [[], [], []]
      const rankKosdaqDiffs: number[][] = [[], [], []]

      for (const w of periodKeys) {
        const wKey = String(w).slice(0, 10)
        const sorted = [...filtered.filter(r => String(r.week_start).slice(0, 10) === wKey)]
          .sort((a, b) => getDelta(b) - getDelta(a))
        const returnWeek = returnWeekMap[wKey]
        const bench = returnWeek ? activeBenchmarks[returnWeek] : undefined

        for (let ni = 0; ni < RANKS.length; ni++) {
          const n = RANKS[ni]
          if (sorted.length < n || sorted[n - 1].next_week_return == null) continue
          const topNRet = sorted[n - 1].next_week_return!
          if (bench?.kospi200  != null) rankKospiDiffs[ni].push(topNRet - bench.kospi200)
          if (bench?.kosdaq150 != null) rankKosdaqDiffs[ni].push(topNRet - bench.kosdaq150)
        }
      }

      let kospi200MeanCalc: number | null = null
      let kosdaq150MeanCalc: number | null = null
      {
        const kospiRets: number[] = []
        const kosdaqRets: number[] = []
        for (const w of periodKeys) {
          const wKey = String(w).slice(0, 10)
          const returnWeek = returnWeekMap[wKey]
          const bench = returnWeek ? activeBenchmarks[returnWeek] : undefined
          if (bench?.kospi200  != null) kospiRets.push(bench.kospi200)
          if (bench?.kosdaq150 != null) kosdaqRets.push(bench.kosdaq150)
        }
        if (kospiRets.length  > 0) kospi200MeanCalc  = kospiRets.reduce((a, b) => a + b, 0)  / kospiRets.length
        if (kosdaqRets.length > 0) kosdaq150MeanCalc = kosdaqRets.reduce((a, b) => a + b, 0) / kosdaqRets.length
      }

      const obsKospiMeans  = rankKospiDiffs.map(d => d.length  > 0 ? d.reduce((a, b) => a + b, 0) / d.length : 0)
      const obsKosdaqMeans = rankKosdaqDiffs.map(d => d.length > 0 ? d.reduce((a, b) => a + b, 0) / d.length : 0)

      const topNMeans = RANKS.map((_, ni) => {
        const valid = weeklyReturns.filter(d => d.length > ni)
        return valid.length > 0 ? valid.reduce((s, d) => s + d[ni], 0) / valid.length : null
      })
      const excessRandObs = RANKS.map((_, ni) => {
        const m = topNMeans[ni]; return m != null ? m - weekAvgMean : 0
      })

      const shuffledYs   = [...ys]
      let corrCount      = 0
      const kospiCounts  = [0, 0, 0]
      const kosdaqCounts = [0, 0, 0]
      const randCounts   = [0, 0, 0]

      for (let i = 0; i < N_PERMS; i++) {
        for (let j = shuffledYs.length - 1; j > 0; j--) {
          const k = Math.floor(Math.random() * (j + 1))
          ;[shuffledYs[j], shuffledYs[k]] = [shuffledYs[k], shuffledYs[j]]
        }
        if (Math.abs(pearson(xs, shuffledYs)) >= Math.abs(corrObs)) corrCount++

        for (let ni = 0; ni < RANKS.length; ni++) {
          const valid = weeklyReturns.filter(d => d.length > ni)
          if (valid.length > 0) {
            const randMean = valid.reduce((s, d) => s + d[Math.floor(Math.random() * d.length)], 0) / valid.length
            if (randMean - weekAvgMean >= excessRandObs[ni]) randCounts[ni]++
          }
          if (rankKospiDiffs[ni].length > 0) {
            const pm = rankKospiDiffs[ni].reduce((s, d) => s + d * (Math.random() > 0.5 ? 1 : -1), 0) / rankKospiDiffs[ni].length
            if (pm >= obsKospiMeans[ni]) kospiCounts[ni]++
          }
          if (rankKosdaqDiffs[ni].length > 0) {
            const pm = rankKosdaqDiffs[ni].reduce((s, d) => s + d * (Math.random() > 0.5 ? 1 : -1), 0) / rankKosdaqDiffs[ni].length
            if (pm >= obsKosdaqMeans[ni]) kosdaqCounts[ni]++
          }
        }
      }

      const rankResults: RankResult[] = RANKS.map((rank, ni) => ({
        rank,
        topNMean:     topNMeans[ni] ?? 0,
        excessKospi:  topNMeans[ni] != null && kospi200MeanCalc  != null ? topNMeans[ni]! - kospi200MeanCalc  : null,
        excessKosdaq: topNMeans[ni] != null && kosdaq150MeanCalc != null ? topNMeans[ni]! - kosdaq150MeanCalc : null,
        excessRandom: excessRandObs[ni],
        kospiPValue:  rankKospiDiffs[ni].length  > 0 ? kospiCounts[ni]  / N_PERMS : null,
        kosdaqPValue: rankKosdaqDiffs[ni].length > 0 ? kosdaqCounts[ni] / N_PERMS : null,
        randomPValue: randCounts[ni] / N_PERMS,
      }))

      setSimResult({
        rankResults,
        corrObs,
        corrPValue:    corrCount / N_PERMS,
        kospi200Mean:  kospi200MeanCalc,
        kosdaq150Mean: kosdaq150MeanCalc,
        weekAvgMean,
        hasBenchmark:  rankKospiDiffs[0].length > 0 || rankKosdaqDiffs[0].length > 0,
        nPerms:        N_PERMS,
        nWeeks:        weeklyReturns.length,
      })
      setSimRunning(false)
    }, 50)
  }, [topNFiltered, filtered, activeBenchmarks, getDelta, topN])

  // ── 매매 시뮬레이션 ─────────────────────────────────────────
  const runTradeSim = useCallback(() => {
    setTradeSimRunning(true)
    setTradeSimResult(null)
    setTimeout(() => {
      const allPeriodKeys = [...new Set(activeRows.map(r => String(r.week_start).slice(0, 10)))].sort()
      const annFactor = 52

      let holdingArr: string[] = []   // 현재 보유 섹터 목록
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
        const topNDelta  = byDelta.slice(0, topN).map(r => r.sector_id)
        const totalDelta = wRows.reduce((s, r) => s + r.mention_delta, 0)

        let weekReturn = 0
        const isHolding = holdingArr.length > 0

        if (tradeScenario === 'top1_track') {
          // ── S1: TOP1 추적 ─────────────────────────────────
          const h = holdingArr[0] ?? null
          if (h !== null) {
            const heldDelta = wRows.find(r => r.sector_id === h)?.mention_delta ?? 0
            if (top1Delta !== null && top1Delta !== h) {
              // 1.1: 1위 변경
              tradeLog.push({ week: wKey, action: 'SELL', sectors: [h],         reason: '1.1 TOP1 변경' })
              tradeLog.push({ week: wKey, action: 'BUY',  sectors: [top1Delta], reason: '1.1 TOP1 변경' })
              holdingArr = [top1Delta]; declines = 0
            } else if (heldDelta < 0) {
              declines++
              if (declines >= 2) {
                // 1.2: 2주 연속 하락
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
          // ── 시장전체 N주 연속 하락 → 언급량 1위 매수
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
          // ── 최적 복합: TOP1 즉시 교체 + 시장 전체 3주 연속 하락 → 현금 → 언급량1위 재진입
          if (isHolding) {
            const h = holdingArr[0] ?? null
            if (h !== null && top1Delta !== null && top1Delta !== h) {
              // TOP1 변경 → 즉시 교체 (시장 신호 무관)
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
  }, [activeRows, activeBenchmarks, topN, tradeScenario])

  // ── 전략 최적화 그리드 서치 ────────────────────────────────
  const runOptimization = useCallback(() => {
    setOptRunning(true)
    setOptResults([])
    setTimeout(() => {
      const allKeys = [...new Set(activeRows.map(r => String(r.week_start).slice(0, 10)))].sort()
      const annFactor = 52
      const results: OptResult[] = []

      // 파라미터 공간
      const TOP_NS        = [1, 2, 3]
      const EXIT_TRIGGERS = ['held_delta', 'market_delta']  // 보유 섹터 delta vs 시장 전체 delta
      const DECLINE_NS    = [1, 2, 3]                       // N주 연속 하락 시 매도
      const AFTER_SELLS   = ['cash', 'count_top']           // 매도 후 현금 vs 언급량 최다 매수

      // 한 시뮬레이션 실행 (series 없이 지표만)
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

          // 하락 지표 계산
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
              // 1위 변경 시 리밸런싱
              const newTop = byDelta.slice(0, tN).map(r => r.sector_id).join(',')
              if (newTop !== holdingArr.join(',')) {
                nTrades += 2; holdingArr = topNSids
              }
            }
            weekReturn = getReturn(holdingArr)
            if (holdingArr.length > 0) { holdWeeks++; if (weekReturn > 0) wins++ }
            else cashWeeks++
          } else {
            // 진입: 1위 섹터 delta > 0
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

  // ── 섹터 상세 ─────────────────────────────────────────────
  const [selectedSector, setSelectedSector]           = useState<string | null>(null)
  const [sectorStocks, setSectorStocks]               = useState<StockStat[]>([])
  const [sectorDetailLoading, setSectorDetailLoading] = useState(false)

  const loadSectorDetail = useCallback(async (sectorId: string) => {
    setSectorDetailLoading(true)
    setSectorStocks([])

    const periodKeys = [...new Set(filtered.map(r => String(r.week_start).slice(0, 10)))].sort()
    let dateFrom: string, dateTo: string

    const lastWeek = periodKeys[periodKeys.length - 1] ?? periodKeys[0]
    dateFrom = periodKeys[0] ?? '2020-01-01'
    dateTo = new Date(new Date(lastWeek).getTime() + 7 * 86400000).toISOString().slice(0, 10)

    const { data: stockData } = await supabase
      .from('stocks')
      .select('ticker, name')
      .eq('sector_id', sectorId)

    const tickers = (stockData ?? []).map((s: { ticker: string; name: string }) => s.ticker)
    if (tickers.length === 0) { setSectorDetailLoading(false); return }

    const mentions: { ticker: string; sentiment: number }[] = []
    let mOffset = 0
    while (true) {
      const { data } = await supabase
        .from('raw_mentions')
        .select('ticker, sentiment')
        .in('ticker', tickers)
        .gte('mentioned_at', dateFrom)
        .lte('mentioned_at', dateTo)
        .range(mOffset, mOffset + 999)
      if (!data || data.length === 0) break
      mentions.push(...(data as { ticker: string; sentiment: number }[]))
      if (data.length < 1000) break
      mOffset += 1000
    }

    const stockMap: Record<string, StockStat> = {}
    for (const s of stockData ?? []) {
      stockMap[s.ticker] = { ticker: s.ticker, name: s.name, mention_count: 0, positive_count: 0, negative_count: 0, net_sentiment: 0 }
    }
    for (const m of mentions) {
      if (!stockMap[m.ticker]) continue
      stockMap[m.ticker].mention_count++
      if (m.sentiment ===  1) stockMap[m.ticker].positive_count++
      if (m.sentiment === -1) stockMap[m.ticker].negative_count++
    }

    const result = Object.values(stockMap)
      .filter(s => s.mention_count > 0)
      .map(s => ({ ...s, net_sentiment: s.positive_count - s.negative_count }))
      .sort((a, b) => b.mention_count - a.mention_count)

    setSectorStocks(result)
    setSectorDetailLoading(false)
  }, [filtered])

  useEffect(() => {
    if (selectedSector) loadSectorDetail(selectedSector)
  }, [selectedSector, loadSectorDetail])

  if (loading) return <div className="loading">데이터 불러오는 중...</div>

  return (
    <div>
      <div className="page-header">
        <div className="page-title">백테스트</div>
        <div className="page-sub">{rollingWeeks}주 롤링 언급 증감 → 다음 주 수익률 검증</div>
      </div>

      {/* 신호 선택 */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
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
          <span style={{ fontSize: 12, color: '#6b7280' }}>TOP:</span>
          {[1, 2, 3].map(n => (
            <button
              key={n}
              onClick={() => setTopN(n)}
              style={{
                padding: '4px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                border: `1px solid ${topN === n ? '#3fb950' : '#30363d'}`,
                background: topN === n ? '#3fb95022' : 'transparent',
                color: topN === n ? '#3fb950' : '#6b7280',
              }}
            >
              TOP{n}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: '#6b7280' }}>신호:</span>
          {(['mention', 'positive'] as const).map(s => (
            <button
              key={s}
              onClick={() => setSignal(s)}
              style={{
                padding: '4px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                border: `1px solid ${signal === s ? '#3B82F6' : '#30363d'}`,
                background: signal === s ? '#3B82F622' : 'transparent',
                color: signal === s ? '#3B82F6' : '#6b7280',
              }}
            >
              {s === 'mention' ? '전체 언급량' : '긍정 언급량'}
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
              title={key === 'report' ? '증권사 리서치 리포트 언급량' : key === 'community' ? '네이버 종목토론방 언급량' : '전체 소스 합산'}
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

      {/* 기간 선택 */}
      <div className="chips" style={{ marginBottom: 20 }}>
        {periodOptions.map(opt => (
          <button
            key={opt.weeks}
            className={`chip${period === opt.weeks ? ' on' : ''}`}
            style={period === opt.weeks
              ? { background: '#3B82F622', color: '#3B82F6', borderColor: '#3B82F6' }
              : { background: 'transparent', color: '#6b7280', borderColor: '#30363d' }}
            onClick={() => setPeriod(opt.weeks)}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* 요약 카드 */}
      <div className="top3" style={{ marginBottom: 20 }}>
        {rankAvgs.map((val, i) => (
          <div className="top3-card" key={i}>
            <div className="top3-label">증가량 {i + 1}위 섹터 다음 {periodUnit} 평균 수익률</div>
            <div className="top3-value" style={{ color: val != null && val >= 0 ? '#3fb950' : '#f85149' }}>
              {val != null ? `${val >= 0 ? '+' : ''}${val.toFixed(2)}%` : '-'}
            </div>
          </div>
        ))}
        <div className="top3-card">
          <div className="top3-label">TOP{topN} ↔ 수익률 상관계수</div>
          <div className="top3-value" style={{ color: '#8b949e' }}>
            {correlation != null ? correlation.toFixed(3) : '-'}
            <span style={{ fontSize: 12, marginLeft: 6, color: '#6b7280' }}>
              {correlation != null && correlation > 0.1 ? '(언급↑ → 수익↑)' : ''}
              {correlation != null && correlation < -0.1 ? '(언급↑ → 수익↓)' : ''}
            </span>
          </div>
        </div>
      </div>

      {/* 산점도 */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ color: '#8b949e', fontSize: 13, marginBottom: 12 }}>
          언급 증가량 TOP{topN}(x) vs 다음 주 수익률(y) — 각 점 = (섹터, {'주차'})
          <span style={{ marginLeft: 8, fontSize: 11, color: '#a78bfa' }}>({rollingWeeks}주 롤링 δ)</span>
        </div>
        {scatterData.length === 0 ? (
          <div className="empty">주가 데이터 없음 (fetch-prices 실행 필요)</div>
        ) : (
          <ResponsiveContainer width="100%" height={320}>
            <ScatterChart margin={{ top: 8, right: 16, bottom: 20, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
              <XAxis
                type="number" dataKey="x" name="언급 증가량"
                label={{ value: `언급 증가량 (전${periodUnit === '달' ? '월' : '주'} 대비)`, position: 'insideBottom', offset: -8, fill: '#6b7280', fontSize: 11 }}
                tick={{ fill: '#8b949e', fontSize: 11 }}
                axisLine={{ stroke: '#30363d' }} tickLine={false}
              />
              <YAxis
                type="number" dataKey="y" name="수익률(%)"
                tick={{ fill: '#8b949e', fontSize: 11 }}
                axisLine={false} tickLine={false} width={44}
                tickFormatter={v => `${v.toFixed(1)}%`}
              />
              <Tooltip
                cursor={{ strokeDasharray: '3 3' }}
                contentStyle={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 6, fontSize: 12 }}
                labelStyle={{ color: '#8b949e' }}
                itemStyle={{ color: '#e6edf3' }}
                formatter={(_value, _name, props) => {
                  const { payload } = props
                  const sign = payload.x >= 0 ? '+' : ''
                  const name = payload.sid ? (SECTOR_LABELS[payload.sid] ?? payload.sid) : ''
                  return [
                    `${payload.rank}위 ${name} | 증가량 ${sign}${payload.x} | ${Number(payload.y).toFixed(2)}%`,
                    '',
                  ]
                }}
              />
              <ReferenceLine y={0} stroke="#30363d" strokeDasharray="4 2" />
              <ReferenceLine x={0} stroke="#30363d" strokeDasharray="4 2" />
              <Scatter data={scatterData} opacity={0.6}>
                {scatterData.map((entry, i) => (
                  <Cell key={i} fill={SECTOR_COLORS[entry.sid] ?? '#6b7280'} />
                ))}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* 순열 검정 */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <div style={{ color: '#e6edf3', fontSize: 14, fontWeight: 600 }}>통계 유의성 검정</div>
          <button
            onClick={runSimulation}
            disabled={simRunning || topNFiltered.length === 0}
            style={{
              padding: '5px 14px', borderRadius: 6, border: '1px solid #30363d',
              background: simRunning ? '#21262d' : '#238636', color: '#fff',
              cursor: simRunning ? 'not-allowed' : 'pointer', fontSize: 12,
            }}
          >
            {simRunning ? '계산 중...' : '시뮬레이션 실행 (n=3,000)'}
          </button>
          <span style={{ fontSize: 11, color: '#6b7280' }}>
            벤치마크 {Object.keys(activeBenchmarks).length}{'주'} 로드
            {simResult && ` | ${simResult.nWeeks}${periodUnit} × 3,000회`}
          </span>
        </div>

        {!simResult && !simRunning && (
          <div style={{ color: '#6b7280', fontSize: 13 }}>
            버튼을 눌러 코스피/코스닥 대비 초과수익 유의성을 검정합니다.
            {Object.keys(activeBenchmarks).length === 0 && (
              <span style={{ color: '#f85149', marginLeft: 8 }}>
                (벤치마크 데이터 없음 — fetch-benchmarks 실행 필요)
              </span>
            )}
          </div>
        )}

        {simResult && (() => {
          const fmtR = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
          const fmtE = (v: number | null) => v == null ? '-' : `${v >= 0 ? '+' : ''}${v.toFixed(3)}%`
          const fmtP = (v: number | null) => v == null ? '-' : v < 0.001 ? '<.001' : v.toFixed(3)
          const sig  = (v: number | null) => v != null && v < 0.05
          const cell = (v: number | null) => ({
            color: sig(v) ? '#3fb950' : '#8b949e',
            fontWeight: sig(v) ? 600 : 400,
          })

          const anySig = simResult.rankResults.some(r =>
            sig(r.kospiPValue) || sig(r.kosdaqPValue) || sig(r.randomPValue)
          ) || sig(simResult.corrPValue)

          const benchLabel = simResult.hasBenchmark
            ? `KOSPI200 ${fmtR(simResult.kospi200Mean!)} / KOSDAQ150 ${fmtR(simResult.kosdaq150Mean!)}`
            : '(벤치마크 없음)'

          return (
            <div>
              <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 10 }}>
                전체 섹터 {'주간'} 평균: <span style={{ color: '#e6edf3' }}>{fmtR(simResult.weekAvgMean)}</span>
                {simResult.hasBenchmark && (
                  <span style={{ marginLeft: 16 }}>벤치마크: <span style={{ color: '#e6edf3' }}>{benchLabel}</span></span>
                )}
              </div>

              <div style={{ overflowX: 'auto', marginBottom: 16 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ color: '#6b7280', borderBottom: '1px solid #21262d' }}>
                      <th style={{ textAlign: 'left',  padding: '6px 8px' }}>전략</th>
                      <th style={{ textAlign: 'right', padding: '6px 8px' }}>수익률/{periodUnit}</th>
                      {simResult.hasBenchmark && <>
                        <th style={{ textAlign: 'right', padding: '6px 8px' }}>vs KOSPI200</th>
                        <th style={{ textAlign: 'right', padding: '6px 8px' }}>p값</th>
                        <th style={{ textAlign: 'right', padding: '6px 8px' }}>vs KOSDAQ150</th>
                        <th style={{ textAlign: 'right', padding: '6px 8px' }}>p값</th>
                      </>}
                      <th style={{ textAlign: 'right', padding: '6px 8px' }}>vs 랜덤</th>
                      <th style={{ textAlign: 'right', padding: '6px 8px' }}>p값</th>
                    </tr>
                  </thead>
                  <tbody>
                    {simResult.rankResults.map(r => (
                      <tr key={r.rank} style={{ borderBottom: '1px solid #161b22' }}>
                        <td style={{ padding: '7px 8px', color: '#e6edf3', fontWeight: 600 }}>TOP{r.rank}</td>
                        <td style={{ padding: '7px 8px', textAlign: 'right', color: r.topNMean >= 0 ? '#3fb950' : '#f85149' }}>
                          {fmtR(r.topNMean)}
                        </td>
                        {simResult.hasBenchmark && <>
                          <td style={{ padding: '7px 8px', textAlign: 'right', color: r.excessKospi != null ? (r.excessKospi >= 0 ? '#3fb950' : '#f85149') : '#6b7280' }}>
                            {fmtE(r.excessKospi)}
                          </td>
                          <td style={{ padding: '7px 8px', textAlign: 'right', ...cell(r.kospiPValue) }}>
                            {fmtP(r.kospiPValue)}{sig(r.kospiPValue) ? ' ✓' : ''}
                          </td>
                          <td style={{ padding: '7px 8px', textAlign: 'right', color: r.excessKosdaq != null ? (r.excessKosdaq >= 0 ? '#3fb950' : '#f85149') : '#6b7280' }}>
                            {fmtE(r.excessKosdaq)}
                          </td>
                          <td style={{ padding: '7px 8px', textAlign: 'right', ...cell(r.kosdaqPValue) }}>
                            {fmtP(r.kosdaqPValue)}{sig(r.kosdaqPValue) ? ' ✓' : ''}
                          </td>
                        </>}
                        <td style={{ padding: '7px 8px', textAlign: 'right', color: r.excessRandom >= 0 ? '#3fb950' : '#f85149' }}>
                          {fmtE(r.excessRandom)}
                        </td>
                        <td style={{ padding: '7px 8px', textAlign: 'right', ...cell(r.randomPValue) }}>
                          {fmtP(r.randomPValue)}{sig(r.randomPValue) ? ' ✓' : ''}
                        </td>
                      </tr>
                    ))}
                    <tr style={{ borderBottom: '1px solid #161b22' }}>
                      <td style={{ padding: '7px 8px', color: '#8b949e' }} colSpan={2}>
                        상관계수 (증가량↔수익률)
                        <div style={{ fontSize: 11, color: '#6b7280' }}>r = {simResult.corrObs >= 0 ? '+' : ''}{simResult.corrObs.toFixed(4)}</div>
                      </td>
                      {simResult.hasBenchmark && <td colSpan={4} />}
                      <td colSpan={2} style={{ padding: '7px 8px', textAlign: 'right', ...cell(simResult.corrPValue) }}>
                        {fmtP(simResult.corrPValue)}{sig(simResult.corrPValue) ? ' ✓' : ''}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div style={{
                padding: '12px 14px', borderRadius: 8,
                background: anySig ? '#1a3a1a' : '#2a1a1a',
                border: `1px solid ${anySig ? '#238636' : '#f8514944'}`,
                fontSize: 13, color: '#e6edf3', lineHeight: 1.6,
              }}>
                <strong>결론: </strong>
                {!simResult.hasBenchmark && '벤치마크 데이터가 없습니다. fetch-benchmarks를 실행해 코스피/코스닥 대비 검정을 진행하세요.'}
                {simResult.hasBenchmark && !anySig && '유의한 신호가 없습니다. 데이터를 더 모은 후 재검정을 권장합니다.'}
                {simResult.hasBenchmark && anySig && simResult.rankResults.map(r => {
                  const sigs = [
                    sig(r.kospiPValue)  && `KOSPI200 대비 +${r.excessKospi?.toFixed(2)}% (p=${fmtP(r.kospiPValue)})`,
                    sig(r.kosdaqPValue) && `KOSDAQ150 대비 +${r.excessKosdaq?.toFixed(2)}% (p=${fmtP(r.kosdaqPValue)})`,
                    sig(r.randomPValue) && `랜덤 대비 +${r.excessRandom.toFixed(2)}% (p=${fmtP(r.randomPValue)})`,
                  ].filter(Boolean)
                  return sigs.length > 0 ? `TOP${r.rank}: ${sigs.join(', ')}  ` : null
                })}
              </div>
            </div>
          )
        })()}
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
          const green = '#3fb950', red = '#f85149', gray = '#8b949e'
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
            { label: `${periodUnit}간 승률`, val: `${tradeSimResult.winRate.toFixed(1)}%`, color: tradeSimResult.winRate >= 50 ? green : red },
            { label: '보유 기간', val: `${tradeSimResult.holdWeeks}${periodUnit}`, color: gray },
            { label: '현금 기간', val: `${tradeSimResult.cashWeeks}${periodUnit}`, color: gray },
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
                        <td style={{ padding: '5px 8px', textAlign: 'right', color: r.totalReturn >= 0 ? '#3fb950' : '#f85149', fontWeight: isBest ? 700 : 400 }}>
                          {fmtR(r.totalReturn)}
                        </td>
                        <td style={{ padding: '5px 8px', textAlign: 'right', color: r.annReturn >= 0 ? '#3fb950' : '#f85149' }}>
                          {fmtR(r.annReturn)}
                        </td>
                        <td style={{ padding: '5px 8px', textAlign: 'right', color: r.winRate >= 50 ? '#3fb950' : '#f85149' }}>
                          {r.winRate.toFixed(1)}%
                        </td>
                        <td style={{ padding: '5px 8px', textAlign: 'right', color: '#f85149' }}>
                          -{r.maxDrawdown.toFixed(1)}%
                        </td>
                        <td style={{ padding: '5px 8px', textAlign: 'right', color: '#8b949e' }}>{r.holdWeeks}</td>
                        <td style={{ padding: '5px 8px', textAlign: 'right', color: '#8b949e' }}>{r.cashWeeks}</td>
                        <td style={{ padding: '5px 8px', textAlign: 'right', color: '#8b949e' }}>{r.nTrades}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )
        })()}
      </div>

      {/* 섹터별 테이블 */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ color: '#8b949e', fontSize: 13, marginBottom: 12 }}>
          섹터별 집계 — 매 주 TOP{topN} 언급 증가 섹터만 포함 · 클릭 시 종목 상세
        </div>
        {sectorSummary.length === 0 ? (
          <div className="empty">주가 데이터 없음</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ color: '#6b7280', borderBottom: '1px solid #21262d' }}>
                <th style={{ textAlign: 'left', padding: '6px 8px' }}>섹터</th>
                <th style={{ textAlign: 'right', padding: '6px 8px' }}>평균 언급 증가량</th>
                <th style={{ textAlign: 'right', padding: '6px 8px' }}>다음 {periodUnit} 평균 수익률</th>
                <th style={{ textAlign: 'right', padding: '6px 8px' }}>승률 (수익&gt;0)</th>
                <th style={{ textAlign: 'right', padding: '6px 8px' }}>샘플수</th>
              </tr>
            </thead>
            <tbody>
              {sectorSummary.map(s => {
                const isSelected = selectedSector === s.sector_id
                const sColor = SECTOR_COLORS[s.sector_id] ?? '#e6edf3'
                return (
                  <tr
                    key={s.sector_id}
                    onClick={() => setSelectedSector(isSelected ? null : s.sector_id)}
                    style={{
                      borderBottom: '1px solid #161b22',
                      cursor: 'pointer',
                      background: isSelected ? `${sColor}14` : 'transparent',
                      transition: 'background 0.15s',
                    }}
                  >
                    <td style={{ padding: '6px 8px', color: sColor, fontWeight: isSelected ? 600 : 400 }}>
                      {isSelected ? '▾ ' : ''}{SECTOR_LABELS[s.sector_id] ?? s.sector_id}
                    </td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', color: s.avg_delta >= 0 ? '#3fb950' : '#f85149' }}>
                      {s.avg_delta >= 0 ? '+' : ''}{s.avg_delta.toFixed(1)}
                    </td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', color: s.avg_return >= 0 ? '#3fb950' : '#f85149' }}>
                      {s.avg_return >= 0 ? '+' : ''}{s.avg_return.toFixed(2)}%
                    </td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', color: s.win_rate >= 50 ? '#3fb950' : '#f85149' }}>
                      {s.win_rate.toFixed(1)}%
                    </td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', color: '#6b7280' }}>
                      {s.count}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* 섹터 상세 */}
      {selectedSector && (() => {
        const sColor = SECTOR_COLORS[selectedSector] ?? '#6b7280'
        const sLabel = SECTOR_LABELS[selectedSector] ?? selectedSector
        return (
          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
              <div style={{ width: 3, height: 16, borderRadius: 2, background: sColor }} />
              <div style={{ fontSize: 14, fontWeight: 600, color: sColor }}>{sLabel} 상세</div>
              <div style={{ fontSize: 12, color: '#6b7280' }}>
                기간: {period >= 999 ? '전체' : `최근 ${period}${periodUnit}`} · 종목별 누적 언급
              </div>
              <button
                onClick={() => setSelectedSector(null)}
                style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 16 }}
              >×</button>
            </div>

            {sectorDetailLoading ? (
              <div style={{ color: '#6b7280', fontSize: 13 }}>종목 데이터 로딩 중...</div>
            ) : sectorStocks.length === 0 ? (
              <div style={{ color: '#6b7280', fontSize: 13 }}>해당 기간 언급 데이터 없음</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ color: '#6b7280', borderBottom: '1px solid #21262d' }}>
                    <th style={{ textAlign: 'left',  padding: '5px 8px' }}>#</th>
                    <th style={{ textAlign: 'left',  padding: '5px 8px' }}>종목명</th>
                    <th style={{ textAlign: 'left',  padding: '5px 8px', color: '#6b7280', fontSize: 11 }}>티커</th>
                    <th style={{ textAlign: 'right', padding: '5px 8px' }}>언급 수</th>
                    <th style={{ textAlign: 'right', padding: '5px 8px' }}>긍정</th>
                    <th style={{ textAlign: 'right', padding: '5px 8px' }}>부정</th>
                    <th style={{ textAlign: 'right', padding: '5px 8px' }}>긍정-부정</th>
                  </tr>
                </thead>
                <tbody>
                  {sectorStocks.map((st, i) => {
                    const isLeader = i === 0
                    return (
                      <tr
                        key={st.ticker}
                        style={{
                          borderBottom: '1px solid #161b22',
                          background: isLeader ? `${sColor}18` : 'transparent',
                        }}
                      >
                        <td style={{ padding: '5px 8px', color: '#6b7280' }}>{i + 1}</td>
                        <td style={{ padding: '5px 8px', color: isLeader ? sColor : '#e6edf3', fontWeight: isLeader ? 600 : 400 }}>
                          {isLeader && <span style={{ fontSize: 10, marginRight: 6, padding: '1px 5px', borderRadius: 4, background: `${sColor}33`, border: `1px solid ${sColor}55` }}>대장주</span>}
                          {st.name}
                        </td>
                        <td style={{ padding: '5px 8px', color: '#6b7280', fontSize: 11 }}>{st.ticker}</td>
                        <td style={{ padding: '5px 8px', textAlign: 'right', color: '#e6edf3', fontWeight: isLeader ? 600 : 400 }}>
                          {st.mention_count.toLocaleString()}
                        </td>
                        <td style={{ padding: '5px 8px', textAlign: 'right', color: '#3fb950' }}>
                          {st.positive_count.toLocaleString()}
                        </td>
                        <td style={{ padding: '5px 8px', textAlign: 'right', color: '#f85149' }}>
                          {st.negative_count.toLocaleString()}
                        </td>
                        <td style={{ padding: '5px 8px', textAlign: 'right', fontWeight: 600,
                          color: st.net_sentiment > 0 ? '#3fb950' : st.net_sentiment < 0 ? '#f85149' : '#6b7280' }}>
                          {st.net_sentiment > 0 ? '+' : ''}{st.net_sentiment.toLocaleString()}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        )
      })()}
    </div>
  )
}

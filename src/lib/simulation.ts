import type { BacktestRow, SectorReturn, RawStat, TradeScenario, SourceFilter } from '../types'

export interface SimParams {
  rawStats:     RawStat[]
  rawReturns:   SectorReturn[]
  benchmarks:   Record<string, { kospi200: number | null; kosdaq150: number | null }>
  scenario:     TradeScenario
  rollingWeeks: number
  confirmWeeks: number
  sourceFilter: SourceFilter
  fromDate?:    string
  toDate?:      string
}

export interface TradeLog {
  week:    string
  action:  'BUY' | 'SELL'
  sectors: string[]
  reason?: string
}

export interface SimResult {
  series:         { week: string; strat: number; kospi200: number | null; kosdaq150: number | null }[]
  totalReturn:    number
  annReturn:      number
  maxDrawdown:    number
  winRate:        number
  nBuys:          number
  nSells:         number
  holdWeeks:      number
  cashWeeks:      number
  benchKospi:     number | null
  benchKosdaq:    number | null
  currentHolding: string[] | null
  currentWeek:    string | null
  tradeLog:       TradeLog[]
}

// ── 소스 필터 적용 → BacktestRow 생성 ──────────────────────
function buildRows(rawStats: RawStat[], rawReturns: SectorReturn[], sourceFilter: SourceFilter): BacktestRow[] {
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
}

// ── 롤링 집계 ───────────────────────────────────────────────
function buildRollingRows(rows: BacktestRow[], rollingWeeks: number): BacktestRow[] {
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
}

// ── 정규화 (0~100) ──────────────────────────────────────────
function normalize(values: number[]): number[] {
  const min = Math.min(...values), max = Math.max(...values)
  if (max === min) return values.map(() => 50)
  return values.map(v => ((v - min) / (max - min)) * 100)
}

// ── 메인 시뮬레이션 (순수 함수) ─────────────────────────────
export function runSimulation(params: SimParams): SimResult {
  const { rawStats, rawReturns, benchmarks, scenario, rollingWeeks, confirmWeeks, sourceFilter, fromDate, toDate } = params

  const rows        = buildRows(rawStats, rawReturns, sourceFilter)
  const activeRows  = buildRollingRows(rows, rollingWeeks)

  let allPeriodKeys = [...new Set(activeRows.map(r => String(r.week_start).slice(0, 10)))].sort()
  if (fromDate) allPeriodKeys = allPeriodKeys.filter(w => w >= fromDate)
  if (toDate)   allPeriodKeys = allPeriodKeys.filter(w => w <= toDate)

  const annFactor = 52
  let holdingArr: string[] = []
  const top1Streak: Record<string, number> = {}

  const series: SimResult['series'] = []
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
    const bench = returnWeek ? benchmarks[returnWeek] : undefined
    const tradeable = wRows.filter(r => r.sector_id !== 'ETC' && r.sector_id !== 'NASDAQ_TOP10')

    let top1: string | null = null
    let enterSignal = true
    let signalReason = ''

    if (scenario === 'top1_count') {
      const sorted = [...tradeable].sort((a, b) => b.mention_count - a.mention_count)
      top1 = sorted[0]?.sector_id ?? null
      signalReason = `언급량 ${sorted[0]?.mention_count ?? 0}건`

    } else if (scenario === 'top1_delta') {
      const sorted = [...tradeable].sort((a, b) => b.mention_delta - a.mention_delta)
      top1 = sorted[0]?.sector_id ?? null
      enterSignal = (sorted[0]?.mention_delta ?? 0) > 0
      signalReason = `증가량 +${sorted[0]?.mention_delta ?? 0}건`

    } else if (scenario === 'top1_rate') {
      const withRate = tradeable.map(r => {
        const prev = r.mention_count - r.mention_delta
        const rate = prev > 0 ? (r.mention_delta / prev) * 100 : 0
        return { ...r, rate }
      }).sort((a, b) => b.rate - a.rate)
      top1 = withRate[0]?.sector_id ?? null
      enterSignal = (withRate[0]?.rate ?? 0) > 0
      signalReason = `증가율 +${(withRate[0]?.rate ?? 0).toFixed(1)}%`

    } else {
      // top1_composite
      const counts = tradeable.map(r => r.mention_count)
      const deltas = tradeable.map(r => r.mention_delta)
      const rates  = tradeable.map(r => {
        const prev = r.mention_count - r.mention_delta
        return prev > 0 ? (r.mention_delta / prev) * 100 : 0
      })
      const nCounts = normalize(counts)
      const nDeltas = normalize(deltas)
      const nRates  = normalize(rates)
      const composite = tradeable.map((r, i) => ({
        sector_id: r.sector_id,
        score: (nCounts[i] + nDeltas[i] + nRates[i]) / 3,
      })).sort((a, b) => b.score - a.score)
      top1 = composite[0]?.sector_id ?? null
      const topScore = composite[0]?.score ?? 0
      enterSignal = topScore > 33
      signalReason = `혼합점수 ${topScore.toFixed(1)}점`
    }

    for (const sid of tradeable.map(r => r.sector_id)) {
      if (sid === top1 && enterSignal) {
        top1Streak[sid] = (top1Streak[sid] ?? 0) + 1
      } else {
        top1Streak[sid] = 0
      }
    }
    const confirmed = top1 !== null && (top1Streak[top1] ?? 0) >= confirmWeeks

    let weekReturn = 0
    const currentTop1 = holdingArr[0] ?? null

    if (confirmed) {
      if (currentTop1 !== top1) {
        if (currentTop1) tradeLog.push({ week: wKey, action: 'SELL', sectors: [currentTop1], reason: 'TOP1 변경' })
        tradeLog.push({ week: wKey, action: 'BUY', sectors: [top1!], reason: `${signalReason} (${confirmWeeks}주 연속)` })
        holdingArr = [top1!]
      }
      weekReturn = applyReturn(holdingArr, wRows)
      holdWeeks++; if (weekReturn > 0) wins++
    } else {
      if (currentTop1 && !enterSignal) {
        tradeLog.push({ week: wKey, action: 'SELL', sectors: [currentTop1], reason: '신호 없음 (현금)' })
        holdingArr = []
        cashWeeks++
      } else if (holdingArr.length > 0) {
        weekReturn = applyReturn(holdingArr, wRows)
        holdWeeks++; if (weekReturn > 0) wins++
      } else {
        cashWeeks++
      }
    }

    cumStrat *= (1 + weekReturn / 100)
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

  const nPeriods   = allPeriodKeys.length
  const totalReturn = cumStrat - 100
  const annReturn   = nPeriods > 0 ? (Math.pow(cumStrat / 100, annFactor / nPeriods) - 1) * 100 : 0

  return {
    series,
    totalReturn,
    annReturn,
    maxDrawdown:    maxDD,
    winRate:        holdWeeks > 0 ? wins / holdWeeks * 100 : 0,
    nBuys:          tradeLog.filter(t => t.action === 'BUY').length,
    nSells:         tradeLog.filter(t => t.action === 'SELL').length,
    holdWeeks,
    cashWeeks,
    benchKospi:     hasBenchKospi  ? cumKospi  - 100 : null,
    benchKosdaq:    hasBenchKosdaq ? cumKosdaq - 100 : null,
    currentHolding: holdingArr.length > 0 ? holdingArr : null,
    currentWeek:    allPeriodKeys[allPeriodKeys.length - 1] ?? null,
    tradeLog,
  }
}

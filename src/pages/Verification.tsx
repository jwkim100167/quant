import { useEffect, useState, useMemo, useCallback } from 'react'
import {
  ScatterChart, Scatter, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, ReferenceLine, Cell,
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

export default function Verification() {
  const [rawStats, setRawStats]     = useState<RawStat[]>([])
  const [rawReturns, setRawReturns] = useState<SectorReturn[]>([])
  const [loading, setLoading]       = useState(true)
  const [period, setPeriod]             = useState(52)
  const [rollingWeeks, setRollingWeeks] = useState(13)
  const [topN, setTopN]                 = useState(1)
  const [signal, setSignal]             = useState<'mention' | 'positive'>('mention')
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('report')
  const [benchmarks, setBenchmarks]     = useState<Record<string, { kospi200: number | null; kosdaq150: number | null }>>({})

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
  const periodOptions    = ROLLING_PERIODS
  const periodUnit       = '주'

  const getDelta = useCallback(
    (r: BacktestRow) => signal === 'positive' ? r.positive_delta : r.mention_delta,
    [signal]
  )

  const filtered = useMemo(() => {
    if (activeRows.length === 0) return []
    const periodsWithData = [...new Set(
      activeRows.filter(r => r.next_week_return !== null).map(r => r.week_start)
    )].sort().reverse()
    const cutPeriods = new Set(periodsWithData.slice(0, period))
    return activeRows.filter(r => cutPeriods.has(r.week_start) && r.next_week_return !== null)
  }, [activeRows, period])

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

  const correlation = useMemo(() => {
    if (topNFiltered.length < 5) return null
    return pearson(topNFiltered.map(r => getDelta(r)), topNFiltered.map(r => r.next_week_return!))
  }, [topNFiltered, getDelta])

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

  // ── 섹터 상세 ─────────────────────────────────────────────
  const [selectedSector, setSelectedSector]           = useState<string | null>(null)
  const [sectorStocks, setSectorStocks]               = useState<StockStat[]>([])
  const [sectorDetailLoading, setSectorDetailLoading] = useState(false)

  const loadSectorDetail = useCallback(async (sectorId: string) => {
    setSectorDetailLoading(true)
    setSectorStocks([])

    const periodKeys = [...new Set(filtered.map(r => String(r.week_start).slice(0, 10)))].sort()
    const lastWeek = periodKeys[periodKeys.length - 1] ?? periodKeys[0]
    const dateFrom = periodKeys[0] ?? '2020-01-01'
    const dateTo   = new Date(new Date(lastWeek).getTime() + 7 * 86400000).toISOString().slice(0, 10)

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
        .neq('source', 'community')
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
        <div className="page-title">신호 검증</div>
        <div className="page-sub">{rollingWeeks}주 롤링 언급 증감 → 다음 주 수익률 상관관계 검증</div>
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
                label={{ value: `언급 증가량 (전${'주'} 대비)`, position: 'insideBottom', offset: -8, fill: '#6b7280', fontSize: 11 }}
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

      {/* 통계 유의성 검정 */}
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

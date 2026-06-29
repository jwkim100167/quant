import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { runSimulation } from '../lib/simulation'
import type { SimResult } from '../lib/simulation'
import {
  SECTOR_LABELS, SECTOR_ETF,
  type RawStat, type SectorReturn, type UserStrategy,
  type TradeScenario,
} from '../types'

const TRADE_SCENARIOS: { key: TradeScenario; label: string; desc: string }[] = [
  { key: 'top1_count',     label: 'TOP1 언급량',    desc: '롤링 기간 내 총 언급량이 가장 많은 섹터 보유' },
  { key: 'top1_delta',     label: 'TOP1 언급증가량', desc: '전 기간 대비 언급 증가량이 가장 큰 섹터 보유' },
  { key: 'top1_rate',      label: 'TOP1 언급증가율', desc: '전 기간 대비 언급 증가율이 가장 높은 섹터 보유' },
  { key: 'top1_composite', label: 'TOP1 혼합',       desc: '언급량·증가량·증가율 합산 TOP1 섹터 보유' },
]

const ROLLING_WEEKS_FIXED = 13
const SOURCE_FILTER_FIXED = 'report' as const

const DEFAULT_STRATEGY: Omit<UserStrategy, 'id' | 'user_id' | 'created_at' | 'updated_at'> = {
  name:          '내 전략',
  scenario:      'top1_composite',
  rolling_weeks: ROLLING_WEEKS_FIXED,
  confirm_weeks: 1,
  source_filter: SOURCE_FILTER_FIXED,
  sim_from_date: null,
  is_active:     true,
}

export default function MyPage() {
  const { user } = useAuth()

  // 전략 설정
  const [strategyId, setStrategyId]             = useState<string | null>(null)
  const [strategyCreatedAt, setStrategyCreatedAt] = useState<string | null>(null)
  const [strategyLoaded, setStrategyLoaded]     = useState(false)
  const [scenario, setScenario]                 = useState<TradeScenario>(DEFAULT_STRATEGY.scenario)
  const [confirmWeeks, setConfirmWeeks]         = useState(DEFAULT_STRATEGY.confirm_weeks)
  const [savedScenario, setSavedScenario]       = useState<TradeScenario | null>(null)
  const [savedConfirmWeeks, setSavedConfirmWeeks] = useState<number | null>(null)

  // 자동매매 시작 확인 상태
  const [showConfirm, setShowConfirm] = useState(false)
  const [saving, setSaving]           = useState(false)
  const [saveMsg, setSaveMsg]         = useState<string | null>(null)

  // 시장 데이터
  const [rawStats, setRawStats]     = useState<RawStat[]>([])
  const [rawReturns, setRawReturns] = useState<SectorReturn[]>([])
  const [benchmarks, setBenchmarks] = useState<Record<string, { kospi200: number | null; kosdaq150: number | null }>>({})
  const [dataLoading, setDataLoading] = useState(true)

  // 시뮬레이션 결과
  const [simResult, setSimResult]   = useState<SimResult | null>(null)
  const [simRunning, setSimRunning] = useState(false)

  // ── 전략 로드 ─────────────────────────────────────────────
  useEffect(() => {
    if (!user) { setStrategyLoaded(true); return }
    supabase
      .from('user_strategies')
      .select('*')
      .eq('user_id', user.id)
      .eq('is_active', true)
      .limit(1)
      .then(({ data }) => {
        if (data && data.length > 0) {
          const s = data[0] as UserStrategy
          setStrategyId(s.id)
          setScenario(s.scenario)
          setConfirmWeeks(s.confirm_weeks)
          setStrategyCreatedAt(s.created_at)
          setSavedScenario(s.scenario)
          setSavedConfirmWeeks(s.confirm_weeks)
        }
        setStrategyLoaded(true)
      })
  }, [user])

  // ── 시장 데이터 로드 ──────────────────────────────────────
  useEffect(() => {
    async function load() {
      setDataLoading(true)

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

      const benchRows: { week_start: string; kospi200_ret: number | null; kosdaq150_ret: number | null }[] = []
      let bOffset = 0
      while (true) {
        const { data } = await supabase
          .from('weekly_benchmark_returns')
          .select('week_start,kospi200_ret,kosdaq150_ret')
          .order('week_start', { ascending: true })
          .range(bOffset, bOffset + 999)
        if (!data || data.length === 0) break
        benchRows.push(...(data as typeof benchRows))
        if (data.length < 1000) break
        bOffset += 1000
      }

      const bMap: Record<string, { kospi200: number | null; kosdaq150: number | null }> = {}
      for (const b of benchRows) {
        bMap[String(b.week_start).slice(0, 10)] = { kospi200: b.kospi200_ret, kosdaq150: b.kosdaq150_ret }
      }

      setRawStats(stats)
      setRawReturns(returns)
      setBenchmarks(bMap)
      setDataLoading(false)
    }
    load()
  }, [])

  // ── 시뮬레이션 실행 (전체 기간 — 현재 보유/매수일 정확도 위해) ──
  const runSim = useCallback(() => {
    if (rawStats.length === 0) return
    setSimRunning(true)
    setSimResult(null)
    setTimeout(() => {
      const result = runSimulation({
        rawStats,
        rawReturns,
        benchmarks,
        scenario,
        rollingWeeks: ROLLING_WEEKS_FIXED,
        confirmWeeks,
        sourceFilter: SOURCE_FILTER_FIXED,
        // fromDate 없음 → 전체 기간으로 현재 보유 종목과 마지막 매수일 정확히 계산
      })
      setSimResult(result)
      setSimRunning(false)
    }, 50)
  }, [rawStats, rawReturns, benchmarks, scenario, confirmWeeks])

  // 데이터 + 전략 모두 로드됐을 때 자동 실행
  useEffect(() => {
    if (!dataLoading && strategyLoaded && rawStats.length > 0) {
      runSim()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataLoading, strategyLoaded])

  // ── 전략 저장 ─────────────────────────────────────────────
  const saveStrategy = async () => {
    if (!user) return
    setSaving(true)
    setSaveMsg(null)
    setShowConfirm(false)

    const payload = {
      user_id:       user.id,
      name:          '내 전략',
      scenario,
      rolling_weeks: ROLLING_WEEKS_FIXED,
      confirm_weeks: confirmWeeks,
      source_filter: SOURCE_FILTER_FIXED,
      sim_from_date: null,
      is_active:     true,
      updated_at:    new Date().toISOString(),
    }

    let error
    if (strategyId) {
      const res = await supabase.from('user_strategies').update(payload).eq('id', strategyId)
      error = res.error
    } else {
      const res = await supabase.from('user_strategies').insert(payload).select('id,created_at').single()
      error = res.error
      if (!error && res.data) {
        setStrategyId(res.data.id)
        setStrategyCreatedAt(res.data.created_at)
      }
    }

    setSaving(false)
    if (error) {
      setSaveMsg('저장 실패: ' + error.message)
    } else {
      setSavedScenario(scenario)
      setSavedConfirmWeeks(confirmWeeks)
      setSaveMsg('전략이 저장됐습니다.')
      runSim()
    }
    setTimeout(() => setSaveMsg(null), 3000)
  }

  const green = '#22c55e', red = '#f85149', gray = '#8b949e'

  const scenarioLabel = TRADE_SCENARIOS.find(s => s.key === scenario)?.label ?? scenario

  if (dataLoading) return <div className="loading">데이터 불러오는 중...</div>

  const currentSectorId = simResult?.currentHolding?.[0] ?? null
  const etf = currentSectorId ? SECTOR_ETF[currentSectorId] : null
  const sectorLabel = currentSectorId ? (SECTOR_LABELS[currentSectorId] ?? currentSectorId) : null

  // 보유 기간: strategyCreatedAt(실제 매수일) 기준, 없으면 시뮬레이션의 마지막 BUY
  const lastBuy = simResult?.tradeLog.filter(t => t.action === 'BUY').at(-1) ?? null
  const holdingStart = strategyCreatedAt?.slice(0, 10) ?? lastBuy?.week ?? null
  const holdingSinceWeeks = holdingStart
    ? Math.floor((Date.now() - new Date(holdingStart).getTime()) / (7 * 24 * 60 * 60 * 1000))
    : null
  const todayStr = new Date().toISOString().slice(0, 10)

  return (
    <div>
      <div className="page-header">
        <div className="page-title">마이페이지</div>
        <div className="page-sub">{user?.email} 님의 퀀트 전략 현황</div>
      </div>

      {/* ── 전략 설정 카드 ─────────────────────────────────── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-title">내 전략 설정</div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* 시나리오 */}
          <div>
            <div style={{ fontSize: 12, color: gray, marginBottom: 8 }}>시나리오</div>
            <div className="btn-group">
              {TRADE_SCENARIOS.map(s => (
                <button
                  key={s.key}
                  className={`btn${scenario === s.key ? ' active' : ''}`}
                  onClick={() => setScenario(s.key)}
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

          {/* 자동매매 시작 버튼 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <button
              style={{
                padding: '10px 20px',
                background: '#1f6feb',
                border: 'none',
                borderRadius: 8,
                color: '#fff',
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer',
              }}
              onClick={() => setShowConfirm(true)}
              disabled={saving}
            >
              해당 전략으로 다음주부터 자동매매를 시작하시겠습니까?
            </button>
            {saveMsg && (
              <span style={{ fontSize: 12, color: saveMsg.startsWith('저장 실패') ? red : green }}>
                {saveMsg}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ── 자동매매 확인 모달 ────────────────────────────── */}
      {showConfirm && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        }}>
          <div style={{
            background: '#161b22', border: '1px solid #30363d', borderRadius: 12,
            padding: '32px 28px', maxWidth: 420, width: '90%',
          }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#e6edf3', marginBottom: 20 }}>
              자동매매 시작 확인
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 20 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #30363d' }}>
                  <th style={{ textAlign: 'left', padding: '6px 8px', color: '#8b949e', fontWeight: 400 }}>항목</th>
                  <th style={{ textAlign: 'center', padding: '6px 8px', color: '#8b949e', fontWeight: 400 }}>기존</th>
                  <th style={{ textAlign: 'center', padding: '6px 8px', color: '#8b949e', fontWeight: 400 }}>변경</th>
                </tr>
              </thead>
              <tbody>
                <tr style={{ borderBottom: '1px solid #21262d' }}>
                  <td style={{ padding: '10px 8px', color: '#8b949e' }}>시나리오</td>
                  <td style={{ padding: '10px 8px', textAlign: 'center', color: savedScenario ? '#8b949e' : '#4b5563' }}>
                    {savedScenario
                      ? (TRADE_SCENARIOS.find(s => s.key === savedScenario)?.label ?? savedScenario)
                      : '없음 (최초 저장)'}
                  </td>
                  <td style={{ padding: '10px 8px', textAlign: 'center', color: '#e6edf3', fontWeight: 600 }}>
                    {scenarioLabel}
                  </td>
                </tr>
                <tr>
                  <td style={{ padding: '10px 8px', color: '#8b949e' }}>TOP1 연속 확인</td>
                  <td style={{ padding: '10px 8px', textAlign: 'center', color: savedConfirmWeeks != null ? '#8b949e' : '#4b5563' }}>
                    {savedConfirmWeeks != null ? `${savedConfirmWeeks}주` : '-'}
                  </td>
                  <td style={{ padding: '10px 8px', textAlign: 'center', color: '#e6edf3', fontWeight: 600 }}>
                    {confirmWeeks}주
                  </td>
                </tr>
              </tbody>
            </table>
            <div style={{ fontSize: 12, color: '#f59e0b', marginBottom: 20 }}>
              저장 후 다음주부터 해당 전략으로 자동매매를 시작합니다.
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                className="btn"
                onClick={() => setShowConfirm(false)}
              >
                취소
              </button>
              <button
                style={{
                  padding: '8px 20px', background: '#1f6feb', border: 'none',
                  borderRadius: 6, color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer',
                }}
                onClick={saveStrategy}
                disabled={saving}
              >
                {saving ? '저장 중...' : '확인'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 현재 보유 종목 ────────────────────────────────── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-title">현재 보유 종목</div>
        {simRunning ? (
          <div className="loading" style={{ padding: '20px 0' }}>계산 중...</div>
        ) : simResult ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{
              padding: '16px', borderRadius: 8,
              border: `1px solid ${currentSectorId ? '#1f6feb' : '#30363d'}`,
              background: currentSectorId ? '#0d1f3c' : '#161b22',
            }}>
              <div style={{ fontSize: 11, color: gray, marginBottom: 6 }}>
                기준 주차: {todayStr}
              </div>
              {currentSectorId ? (
                <div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: '#e6edf3', marginBottom: 4 }}>
                    {sectorLabel}
                  </div>
                  {etf && (
                    <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 8 }}>
                      {etf.name} · {etf.ticker}
                    </div>
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8, fontSize: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: gray }}>매수일</span>
                      <span style={{ color: '#e6edf3' }}>
                        {holdingStart
                          ? `${parseInt(holdingStart.slice(5, 7))}/${parseInt(holdingStart.slice(8, 10))}`
                          : '-'}
                      </span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: gray }}>보유 기간</span>
                      <span style={{ color: '#e6edf3' }}>{holdingSinceWeeks != null ? `${holdingSinceWeeks}주` : '-'}</span>
                    </div>
                  </div>
                  <div style={{ marginTop: 10 }}>
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
                  <div style={{ fontSize: 20, fontWeight: 700, color: gray }}>현금 대기</div>
                  <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>신호 없음</div>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="empty">데이터를 불러오는 중...</div>
        )}
      </div>

      {/* ── 매매 로그 ──────────────────────────────────────── */}
      {simResult && simResult.tradeLog.length > 0 && (() => {
        // 전략 시작일 이후 로그만 표시 (없으면 전체)
        const filteredLog = strategyCreatedAt
          ? simResult.tradeLog.filter(t => t.week >= strategyCreatedAt.slice(0, 10))
          : simResult.tradeLog
        const buys  = filteredLog.filter(t => t.action === 'BUY').length
        const sells = filteredLog.filter(t => t.action === 'SELL').length
        if (filteredLog.length === 0) return null
        return (
          <div className="card">
            <details>
              <summary style={{ fontSize: 13, color: gray, cursor: 'pointer', userSelect: 'none', marginBottom: 4 }}>
                매매 로그 ({buys}회 매수 / {sells}회 매도)
                {strategyCreatedAt && (
                  <span style={{ fontSize: 11, color: '#4b5563', marginLeft: 8 }}>
                    · 전략 시작일 {strategyCreatedAt.slice(0, 10)} 이후
                  </span>
                )}
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
                    {[...filteredLog].reverse().map((t, i) => (
                      <tr key={i}>
                        <td style={{ padding: '4px 8px', fontSize: 12 }}>{t.week}</td>
                        <td style={{ padding: '4px 8px', fontSize: 12 }}>
                          <span style={{ color: t.action === 'BUY' ? green : red, fontWeight: 600 }}>{t.action}</span>
                        </td>
                        <td style={{ padding: '4px 8px', fontSize: 12 }}>
                          {t.sectors.map(s => SECTOR_LABELS[s] ?? s).join(', ')}
                        </td>
                        <td style={{ padding: '4px 8px', fontSize: 11, color: gray }}>{t.reason ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </div>
        )
      })()}
    </div>
  )
}

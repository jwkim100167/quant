export interface SectorStat {
  sector_id: string
  mention_count: number
  rank: number
  sectors: { sector_name: string } | null
}

export interface StockCount {
  ticker: string
  name: string
  sector_id: string
  count: number
  dart: number
  naver: number
  report: number
}

export interface Stock {
  ticker: string
  name: string
  sector_id: string
}

export interface RawMention {
  ticker: string
  source: string
  mentioned_at: string
}

export interface WeeklyTrendRow {
  week_start: string
  sector_id: string
  mention_count: number
  sectors: { sector_name: string } | null
}

export const SECTOR_COLORS: Record<string, string> = {
  SEMICONDUCTOR: '#3B82F6',
  BATTERY:       '#06B6D4',
  BIOTECH:       '#F59E0B',
  HEALTH:        '#EF4444',
  GAME:          '#A855F7',
  COSMETIC:      '#FB7185',
  SHIPBUILDING:  '#0EA5E9',
  AUTO:          '#6366F1',
  CHEMICAL:      '#84CC16',
  FINANCE:       '#10B981',
  TELECOM:       '#14B8A6',
  ENERGY:        '#EAB308',
  INDUSTRIAL:    '#F97316',
  STEEL:         '#78716C',
  PLATFORM:      '#8B5CF6',
  IT:            '#60A5FA',
  CONSTRUCTION:  '#92400E',
  FOOD:          '#D97706',
  RETAIL:        '#BE185D',
  LOGISTICS:     '#0369A1',
  DEFENSE:       '#374151',
  CONSUMER:      '#EC4899',
  NASDAQ_TOP10:  '#F59E0B',
  MATERIAL:      '#64748B',
  ETC:           '#4B5563',
}

// 섹터별 대표 ETF (ticker: KRX 종목코드 또는 US 티커)
export const SECTOR_ETF: Record<string, { ticker: string; name: string }> = {
  SEMICONDUCTOR: { ticker: '091160', name: 'KODEX 반도체' },
  BATTERY:       { ticker: '305720', name: 'KODEX 2차전지산업' },
  BIOTECH:       { ticker: '244580', name: 'KODEX 바이오' },
  AUTO:          { ticker: '091180', name: 'KODEX 자동차' },
  STEEL:         { ticker: '139230', name: 'TIGER 200 중공업' },
  FINANCE:       { ticker: '139270', name: 'TIGER 200 금융' },
  CHEMICAL:      { ticker: '139220', name: 'KODEX 화학' },
  IT:            { ticker: '266360', name: 'KODEX IT' },
  CONSTRUCTION:  { ticker: '139240', name: 'KODEX 건설' },
  SHIPBUILDING:  { ticker: '466920', name: 'SOL 조선TOP3플러스' },
  DEFENSE:       { ticker: '449450', name: 'PLUS K방산' },
  HEALTH:        { ticker: '143860', name: 'TIGER 헬스케어' },
  GAME:          { ticker: '300950', name: 'KODEX 게임산업' },
  COSMETIC:      { ticker: '228790', name: 'TIGER 화장품' },
  ENERGY:        { ticker: '139250', name: 'TIGER 200 에너지화학' },
  INDUSTRIAL:    { ticker: '227550', name: 'TIGER 200 산업재' },
  FOOD:          { ticker: '227560', name: 'TIGER 200 생활소비재' },
  RETAIL:        { ticker: '139290', name: 'TIGER 200 경기소비재' },
  CONSUMER:      { ticker: '266410', name: 'KODEX 필수소비재' },
  NASDAQ_TOP10:  { ticker: 'QQQ',    name: 'Invesco QQQ' },
  // TELECOM, PLATFORM, LOGISTICS, MATERIAL — 신뢰할 코드 미확인
}

export const SECTOR_LABELS: Record<string, string> = {
  SEMICONDUCTOR: '반도체',
  BATTERY:       '이차전지',
  BIOTECH:       '바이오',
  HEALTH:        '헬스케어',
  GAME:          '게임',
  COSMETIC:      '화장품',
  SHIPBUILDING:  '조선',
  AUTO:          '자동차',
  CHEMICAL:      '화학',
  FINANCE:       '금융',
  TELECOM:       '통신',
  ENERGY:        '에너지',
  INDUSTRIAL:    '산업재',
  STEEL:         '철강',
  PLATFORM:      '플랫폼',
  IT:            'IT서비스',
  CONSTRUCTION:  '건설',
  FOOD:          '식품/음료',
  RETAIL:        '유통',
  LOGISTICS:     '물류',
  DEFENSE:       '방산',
  CONSUMER:      '소비재',
  NASDAQ_TOP10:  '나스닥 Top10',
  MATERIAL:      '소재',
  ETC:           '기타',
}

export interface SectorReturn {
  week_start: string
  sector_id: string
  return_pct: number
  stock_count: number
}

export interface BacktestRow {
  week_start: string
  return_week: string          // next_week_return 이 속한 실제 주 (= week_start 다음 주)
  sector_id: string
  mention_delta: number        // 전주 대비 전체 언급 증가량
  positive_delta: number       // 전주 대비 긍정 언급 증가량
  mention_count: number
  positive_count: number
  next_week_return: number | null
}

// ── 시뮬레이션 공용 타입 ────────────────────────────────────

export type TradeScenario = 'top1_count' | 'top1_delta' | 'top1_rate' | 'top1_composite'
export type SourceFilter  = 'all' | 'report' | 'community'

export interface RawStat {
  week_start:      string
  sector_id:       string
  mention_count:   number
  positive_count:  number
  report_count:    number
  community_count: number
}

export interface UserStrategy {
  id:            string
  user_id:       string
  name:          string
  scenario:      TradeScenario
  rolling_weeks: number
  confirm_weeks: number
  source_filter: SourceFilter
  sim_from_date: string | null
  is_active:     boolean
  created_at:    string
  updated_at:    string
}

export function getCurrentWeekStart(): string {
  const now = new Date()
  const day = now.getDay()
  const diff = day === 0 ? -6 : 1 - day
  const monday = new Date(now)
  monday.setDate(now.getDate() + diff)
  return monday.toISOString().split('T')[0]
}

export function formatDate(dateStr: string): string {
  return dateStr.slice(5).replace('-', '/')
}

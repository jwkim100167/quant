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
  IT:            '#8B5CF6',
  FINANCE:       '#10B981',
  HEALTH:        '#EF4444',
  BIOTECH:       '#F59E0B',
  BATTERY:       '#06B6D4',
  AUTO:          '#6366F1',
  CHEMICAL:      '#84CC16',
  INDUSTRIAL:    '#F97316',
  ENERGY:        '#EAB308',
  CONSUMER:      '#EC4899',
  MATERIAL:      '#64748B',
  TELECOM:       '#14B8A6',
  GAME:          '#A855F7',
  COSMETIC:      '#FB7185',
  SHIPBUILDING:  '#0EA5E9',
  ETC:           '#4B5563',
}

export const SECTOR_LABELS: Record<string, string> = {
  SEMICONDUCTOR: '반도체',
  IT:            'IT',
  FINANCE:       '금융',
  HEALTH:        '헬스케어',
  BIOTECH:       '바이오',
  BATTERY:       '이차전지',
  AUTO:          '자동차',
  CHEMICAL:      '화학',
  INDUSTRIAL:    '산업재',
  ENERGY:        '에너지',
  CONSUMER:      '소비재',
  MATERIAL:      '소재',
  TELECOM:       '통신',
  GAME:          '게임',
  COSMETIC:      '화장품',
  SHIPBUILDING:  '조선',
  ETC:           '기타',
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

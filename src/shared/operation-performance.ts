export type TeamPerformanceRange = '7d' | '30d' | 'month';

export interface TeamPerformanceDay {
  date: string;
  collaborator_id: string | null;
  sales_count: number;
  installations_count: number;
}

export interface TeamPerformanceCollaborator {
  id: string;
  name: string;
  role: string;
  work_area: string;
  active: boolean;
  sales_count: number;
  revenue: number;
  margin: number;
  average_ticket: number;
  installations_count: number;
  pickups_count: number;
  deliveries_count: number;
  on_time_pct: number | null;
  average_service_minutes: number | null;
  commission_amount: number;
  missing_cost_items: number;
}

export interface TeamPerformanceSummary {
  sales_count: number;
  revenue: number;
  margin: number;
  installations_count: number;
  deliveries_count: number;
  commission_total: number;
  commission_collaborators: number;
  unassigned_sales: number;
  waiting_pickups: number;
  commission_review_count: number;
  missing_cost_items: number;
}

export interface TeamPerformancePayload {
  range: TeamPerformanceRange;
  period_start: string;
  period_end: string;
  unit_name: string;
  summary: TeamPerformanceSummary;
  daily: TeamPerformanceDay[];
  collaborators: TeamPerformanceCollaborator[];
}

function saoPauloDate(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftIsoDate(value: string, days: number): string {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

export function teamPerformanceBounds(
  range: TeamPerformanceRange,
  now = new Date(),
): { start: string; end: string } {
  const today = saoPauloDate(now);
  return {
    start: range === 'month' ? `${today.slice(0, 7)}-01`
      : shiftIsoDate(today, -(range === '7d' ? 6 : 29)),
    end: shiftIsoDate(today, 1),
  };
}

export function performanceMoney(value: unknown): number {
  return Math.round(Number(value ?? 0) * 100) / 100;
}

import { z } from 'zod';
import { businessDateSaoPaulo } from '../../shared/business-time.js';

export const reportDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(value + 'T12:00:00Z');
  return value >= '1900-01-01' && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
export interface ReportPeriod { from: string; to: string; mode: 'month' | 'week' | 'custom'; compare: 'true' | 'false' }
export const validReportRange = (value: { from: string; to: string }) => value.from <= value.to
  && value.to <= businessDateSaoPaulo(new Date()) && Date.parse(value.to) - Date.parse(value.from) <= 365 * 86400000;
export const reportDay = (value: Date) => value.toISOString().slice(0, 10);
export function reportAddDays(value: string, days: number): string {
  const result = new Date(value + 'T12:00:00Z'); result.setUTCDate(result.getUTCDate() + days); return reportDay(result);
}
export function reportComparison(filter: ReportPeriod) {
  if (filter.compare !== 'true') return null;
  const days = Math.round((Date.parse(filter.to) - Date.parse(filter.from)) / 86400000) + 1;
  if (filter.mode === 'month' && filter.from.endsWith('-01') && filter.from.slice(0, 7) === filter.to.slice(0, 7)) {
    const last = new Date(filter.from + 'T12:00:00Z'); last.setUTCDate(0);
    const to = new Date(last); to.setUTCDate(Math.min(days, last.getUTCDate()));
    const from = new Date(last); from.setUTCDate(1);
    return { from: reportDay(from), to: reportDay(to) };
  }
  return { from: reportAddDays(filter.from, -days), to: reportAddDays(filter.from, -1) };
}

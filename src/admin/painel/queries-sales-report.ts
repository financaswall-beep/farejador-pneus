import type { Pool } from 'pg';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { readSalesReportLines, type ReportLine } from './sales-report-data.js';
import { reportAddDays, salesReportComparison, type SalesReportFilter } from './sales-report-period.js';

const money = (cents: number) => cents / 100;
export function summarizeSalesReport(lines: ReportLine[], showCosts: boolean) {
  const orders = new Set(lines.map(line => line.channel + ':' + line.sale_id)).size;
  const revenue = lines.reduce((sum, line) => sum + line.revenue, 0);
  const pending = lines.filter(line => line.cost === null);
  const knownCost = lines.reduce((sum, line) => sum + (line.cost ?? 0), 0);
  const knownMargin = lines.reduce((sum, line) => sum + (line.cost === null ? 0 : line.revenue - line.cost), 0);
  return { revenue: money(revenue), orders, units: lines.reduce((sum, line) => sum + line.quantity, 0),
    tires: lines.filter(line => line.kind === 'tire').reduce((sum, line) => sum + line.quantity, 0),
    ticket: orders ? money(Math.round(revenue / orders)) : 0,
    cost: showCosts && !pending.length ? money(knownCost) : null,
    margin: showCosts && !pending.length ? money(knownMargin) : null,
    margin_pct: showCosts && !pending.length && revenue ? Math.round(knownMargin / revenue * 1000) / 10 : null,
    known_cost: showCosts ? money(knownCost) : null, known_margin: showCosts ? money(knownMargin) : null,
    pending_cost_lines: showCosts ? pending.length : 0,
    pending_cost_revenue: showCosts ? money(pending.reduce((sum, line) => sum + line.revenue, 0)) : null };
}
function groupLines(lines: ReportLine[], key: (line: ReportLine) => string) {
  const groups = new Map<string, ReportLine[]>();
  for (const line of lines) { const id = key(line); const rows = groups.get(id) ?? []; rows.push(line); groups.set(id, rows); }
  return [...groups.entries()];
}
export function buildSalesReport(source: ReportLine[], filter: SalesReportFilter, showCosts: boolean) {
  const comparison = salesReportComparison(filter);
  const brands = [...new Set(source.map(line => line.brand))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const lines = source.filter(line => (!filter.brand || line.brand === filter.brand)
    && (!filter.condition || line.condition === filter.condition)
    && (!filter.measure || (filter.exact === 'true' ? line.measure === filter.measure
      : line.measure.toLocaleUpperCase('pt-BR').includes(filter.measure.toLocaleUpperCase('pt-BR')))));
  const current = lines.filter(line => line.day >= filter.from && line.day <= filter.to);
  const previous = comparison ? lines.filter(line => line.day >= comparison.from && line.day <= comparison.to) : [];
  const summary = summarizeSalesReport(current, showCosts);
  const old = comparison ? summarizeSalesReport(previous, showCosts) : null;
  const group = (rows: ReportLine[], key: (line: ReportLine) => string) => groupLines(rows, key).map(([id, items]) => ({
    key: id, measure: items[0]!.measure, brand: items[0]!.brand, condition: items[0]!.condition, kind: items[0]!.kind,
    ...summarizeSalesReport(items, showCosts),
  })).sort((a, b) => b.revenue - a.revenue || a.key.localeCompare(b.key));
  const products = group(current, line => JSON.stringify([line.kind, line.measure, line.brand, line.condition]));
  const variants = new Map<string, typeof products>();
  for (const product of products) {
    const key = JSON.stringify([product.kind, product.measure]);
    const rows = variants.get(key) ?? []; rows.push(product); variants.set(key, rows);
  }
  const measures = group(current, line => JSON.stringify([line.kind, line.measure])).map(row => ({ ...row,
    variants: variants.get(row.key) ?? [],
  }));
  const sales = groupLines(current, line => line.channel + ':' + line.sale_id).map(([key, items]) => ({
    key, id: items[0]!.sale_id, channel: items[0]!.channel, day: items[0]!.day,
    ...summarizeSalesReport(items, showCosts),
    items: items.map(line => ({ id: line.id, measure: line.measure, brand: line.brand, condition: line.condition,
      kind: line.kind, quantity: line.quantity, revenue: money(line.revenue), cost: showCosts && line.cost !== null ? money(line.cost) : null,
      margin: showCosts && line.cost !== null ? money(line.revenue - line.cost) : null })),
  })).sort((a, b) => b.day.localeCompare(a.day) || a.key.localeCompare(b.key));
  const dailyMap = (rows: ReportLine[]) => new Map(groupLines(rows, line => line.day)
    .map(([day, items]) => [day, money(items.reduce((total, line) => total + line.revenue, 0))]));
  const actualDays = dailyMap(current), previousDays = dailyMap(previous);
  const daily = [];
  for (let day = filter.from, index = 0; day <= filter.to; day = reportAddDays(day, 1), index++) {
    const priorDay = comparison ? reportAddDays(comparison.from, index) : null;
    daily.push({ day, revenue: actualDays.get(day) ?? 0,
      previous_day: priorDay && priorDay <= comparison!.to ? priorDay : null,
      previous: priorDay && priorDay <= comparison!.to ? previousDays.get(priorDay) ?? 0 : null });
  }
  const channels = (['atacado', 'varejo'] as const).map(channel => ({ channel,
    ...summarizeSalesReport(current.filter(line => line.channel === channel), showCosts) }));
  return { filters: filter, comparison, generated_at: new Date().toISOString(), can_view_costs: showCosts,
    brands, summary, previous: old, daily, channels, measures, products,
    sales: { total: sales.length, offset: filter.offset, rows: sales.slice(filter.offset, filter.offset + 25) },
    export_sales: sales };
}
export async function getSalesReport(filter: SalesReportFilter, showCosts: boolean,
  environment = env.FAREJADOR_ENV, db: Pool = pool) {
  return buildSalesReport(await readSalesReportLines(db, environment, filter), filter, showCosts);
}

import type { Pool } from 'pg';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { readPurchaseReportLines, type PurchaseReportLine } from './purchase-report-data.js';
import { reportAddDays, reportComparison } from './report-period.js';
import type { PurchaseReportFilter } from './purchase-report-period.js';

const money = (value: number) => value / 100;
const variantKey = (line: PurchaseReportLine) => JSON.stringify([line.measure, line.brand, line.condition]);
function groups(lines: PurchaseReportLine[], key: (line: PurchaseReportLine) => string) {
  const result = new Map<string, PurchaseReportLine[]>();
  for (const line of lines) { const id = key(line); const rows = result.get(id) ?? []; rows.push(line); result.set(id, rows); }
  return [...result.entries()];
}
export function summarizePurchases(lines: PurchaseReportLine[], payments: boolean) {
  const purchases = [...new Map(lines.map(line => [line.purchase_id, line])).values()];
  const quantity = lines.reduce((n, line) => n + line.quantity, 0);
  const value = lines.reduce((n, line) => n + line.value, 0);
  const fullTotal = purchases.reduce((n, row) => n + row.full_total, 0), open = purchases.reduce((n, row) => n + row.open, 0);
  return { value: money(value), quantity, purchases: purchases.length,
    received: lines.reduce((n, line) => n + line.received, 0), transit: lines.reduce((n, line) => n + line.transit, 0),
    ordered: lines.reduce((n, line) => n + line.ordered, 0), suppliers: new Set(lines.map(line => line.supplier_id)).size,
    average_cost: quantity ? money(Math.round(value / quantity)) : null,
    full_total: payments ? money(fullTotal) : null, paid: payments ? money(fullTotal - open) : null, open: payments ? money(open) : null };
}
function costChange(current: number | null, previous: number | null) {
  return current !== null && previous !== null && previous > 0 ? Math.round((current - previous) / previous * 1000) / 10 : null;
}
export function buildPurchaseReport(source: PurchaseReportLine[], filter: PurchaseReportFilter, payments: boolean) {
  const comparison = reportComparison(filter);
  const suppliers = [...new Map(source.map(row => [row.supplier_id, { id: row.supplier_id, name: row.supplier_name }])).values()]
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  const brands = [...new Set(source.map(row => row.brand))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const lines = source.filter(row => (!filter.supplier || row.supplier_id === filter.supplier)
    && (!filter.brand || row.brand === filter.brand) && (!filter.condition || row.condition === filter.condition)
    && (filter.receipt === 'all' || row.status === (filter.receipt === 'received' ? 'confirmed' : 'pending'))
    && (!filter.measure || (filter.exact === 'true' ? row.measure === filter.measure : row.measure.includes(filter.measure.toUpperCase()))));
  const current = lines.filter(row => row.day >= filter.from && row.day <= filter.to);
  const previous = comparison ? lines.filter(row => row.day >= comparison.from && row.day <= comparison.to) : [];
  const summary = summarizePurchases(current, payments), old = comparison ? summarizePurchases(previous, payments) : null;
  const productRows = (rows: PurchaseReportLine[]) => groups(rows, variantKey).map(([key, items]) => ({
    key, measure: items[0]!.measure, brand: items[0]!.brand, condition: items[0]!.condition, ...summarizePurchases(items, false),
  })).sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
  const oldProducts = new Map(productRows(previous).map(row => [row.key, row]));
  const productSuppliers = new Map(groups(current, variantKey).map(([key, items]) => [key,
    groups(items, row => row.supplier_id).map(([id, rows]) => ({ id, name: rows[0]!.supplier_name, ...summarizePurchases(rows, false) }))]));
  const products = productRows(current).map(row => ({ ...row,
    previous_average: oldProducts.get(row.key)?.average_cost ?? null,
    change_pct: costChange(row.average_cost, oldProducts.get(row.key)?.average_cost ?? null),
    supplier_rows: productSuppliers.get(row.key) ?? [],
  }));
  const supplierRows = groups(current, row => row.supplier_id).map(([id, items]) => ({
    id, name: items[0]!.supplier_name, ...summarizePurchases(items, payments),
    last_purchase: items.reduce((date, row) => row.day > date ? row.day : date, ''), products: productRows(items),
  })).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
  const purchases = groups(current, row => row.purchase_id).map(([id, items]) => ({
    id, order_code: items[0]!.order_code, day: items[0]!.day, received_on: items[0]!.received_on,
    supplier_id: items[0]!.supplier_id, supplier_name: items[0]!.supplier_name, status: items[0]!.status,
    ...summarizePurchases(items, payments),
    items: items.map(row => ({ id: row.id, measure: row.measure, brand: row.brand, condition: row.condition,
      ordered: row.ordered, quantity: row.quantity, received: row.received, transit: row.transit,
      base_unit_cost: money(row.base_unit_cost), value: money(row.value),
      average_cost: row.quantity ? money(Math.round(row.value / row.quantity)) : null })),
  })).sort((a, b) => b.day.localeCompare(a.day) || a.id.localeCompare(b.id));
  const byDay = (rows: PurchaseReportLine[]) => new Map(groups(rows, row => row.day).map(([date, items]) => [date, summarizePurchases(items, false)]));
  const dailyCurrent = byDay(current), dailyPrevious = byDay(previous), daily = [];
  for (let day = filter.from, index = 0; day <= filter.to; day = reportAddDays(day, 1), index++) {
    const priorDay = comparison ? reportAddDays(comparison.from, index) : null;
    const oldDay = priorDay && priorDay <= comparison!.to ? priorDay : null;
    daily.push({ day, value: dailyCurrent.get(day)?.value ?? 0, received: dailyCurrent.get(day)?.received ?? 0,
      previous_day: oldDay, previous: oldDay ? dailyPrevious.get(oldDay)?.value ?? 0 : null,
      previous_received: oldDay ? dailyPrevious.get(oldDay)?.received ?? 0 : null });
  }
  return { filters: filter, comparison, generated_at: new Date().toISOString(), can_view_payments: payments,
    item_filtered: !!(filter.brand || filter.condition || filter.measure), facets: { suppliers, brands },
    summary, previous: old, average_change_pct: costChange(summary.average_cost, old?.average_cost ?? null),
    daily, products, suppliers: supplierRows,
    purchases: { total: purchases.length, offset: filter.offset, rows: purchases.slice(filter.offset, filter.offset + 25) },
    export_purchases: purchases };
}
export async function getPurchaseReport(filter: PurchaseReportFilter, payments: boolean,
  environment = env.FAREJADOR_ENV, db: Pool = pool) {
  return buildPurchaseReport(await readPurchaseReportLines(db, environment, filter), filter, payments);
}

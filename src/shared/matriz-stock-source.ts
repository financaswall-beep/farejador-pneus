import { tireSizeKey } from './tire-size.js';

export type MatrizStockBlockReason =
  | 'walkin_measure_not_found'
  | 'walkin_stock_insufficient'
  | 'walkin_cost_missing'
  | 'walkin_stock_ambiguous';

export interface MatrizStockRow {
  measure: string;
  quantity_on_hand: number | string;
  unit_cost?: number | string | null;
}

export interface MatrizStockState {
  key: string;
  measure: string | null;
  quantity_on_hand: number;
  unit_cost: number | null;
  rows_count: number;
  sellable: boolean;
  block_reason: MatrizStockBlockReason | null;
}

export type MatrizStockIndex = Map<string, MatrizStockRow[]>;

export function buildMatrizStockIndex(rows: readonly MatrizStockRow[]): MatrizStockIndex {
  const index: MatrizStockIndex = new Map();
  for (const row of rows) {
    const key = tireSizeKey(row.measure);
    if (!key) continue;
    index.set(key, [...(index.get(key) ?? []), row]);
  }
  return index;
}

/**
 * Espelha as travas da venda atomica da Etapa 2. Linhas duplicadas nao
 * sao somadas: a ambiguidade bloqueia a venda ate ser conciliada.
 */
export function matrizStockForMeasure(
  index: MatrizStockIndex,
  measure: string | null | undefined,
): MatrizStockState {
  const key = tireSizeKey(measure);
  const rows = key ? index.get(key) ?? [] : [];
  if (rows.length === 0) {
    return blocked(key, null, 0, null, 0, 'walkin_measure_not_found');
  }
  if (rows.length !== 1) {
    return blocked(key, rows[0]?.measure ?? null, 0, null, rows.length, 'walkin_stock_ambiguous');
  }

  const row = rows[0]!;
  const quantity = Number(row.quantity_on_hand);
  const safeQuantity = Number.isFinite(quantity) ? quantity : 0;
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return blocked(key, row.measure, safeQuantity, parseCost(row.unit_cost), 1, 'walkin_stock_insufficient');
  }

  const unitCost = parseCost(row.unit_cost);
  if (unitCost === null || unitCost <= 0) {
    return blocked(key, row.measure, safeQuantity, unitCost, 1, 'walkin_cost_missing');
  }

  return {
    key,
    measure: row.measure,
    quantity_on_hand: safeQuantity,
    unit_cost: unitCost,
    rows_count: 1,
    sellable: true,
    block_reason: null,
  };
}

function parseCost(value: MatrizStockRow['unit_cost']): number | null {
  if (value === null || value === undefined || value === '') return null;
  const cost = Number(value);
  return Number.isFinite(cost) ? cost : null;
}

function blocked(
  key: string,
  measure: string | null,
  quantity: number,
  unitCost: number | null,
  rowsCount: number,
  reason: MatrizStockBlockReason,
): MatrizStockState {
  return {
    key,
    measure,
    quantity_on_hand: quantity,
    unit_cost: unitCost,
    rows_count: rowsCount,
    sellable: false,
    block_reason: reason,
  };
}

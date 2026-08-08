import { tireSizeKey } from './tire-size.js';
import {
  canonicalTireCondition,
  type TireCondition,
} from './tire-condition.js';

export type MatrizStockBlockReason =
  | 'walkin_measure_not_found'
  | 'walkin_stock_insufficient'
  | 'walkin_cost_missing'
  | 'walkin_stock_ambiguous';

export interface MatrizStockRow {
  measure: string;
  brand?: string | null;
  tire_condition?: TireCondition | string | null;
  quantity_on_hand: number | string;
  quantity_reserved?: number | string | null;
  unit_cost?: number | string | null;
}

export interface MatrizStockState {
  key: string;
  measure: string | null;
  brand: string | null;
  tire_condition: TireCondition | null;
  quantity_on_hand: number;
  quantity_reserved: number;
  quantity_available: number;
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
  brand?: string | null,
  tireCondition?: TireCondition | string | null,
): MatrizStockState {
  const key = tireSizeKey(measure);
  const candidates = key ? index.get(key) ?? [] : [];
  const wantedBrand = brandKey(brand);
  const wantedCondition = canonicalTireCondition(tireCondition) ?? 'meia_vida';
  let rows = wantedBrand
    ? candidates.filter((row) => brandKey(row.brand) === wantedBrand)
    : candidates;
  rows = rows.filter(
    (row) => (canonicalTireCondition(row.tire_condition) ?? 'meia_vida') === wantedCondition,
  );
  // Compatibilidade defensiva durante migrações/fixtures antigos: uma única
  // linha sem marca ainda é inequívoca. Com duas linhas, continua bloqueado.
  if (wantedBrand && rows.length === 0 && candidates.length === 1
    && (canonicalTireCondition(candidates[0]?.tire_condition) ?? 'meia_vida') === wantedCondition
    && (!brandKey(candidates[0]?.brand)
      || brandKey(candidates[0]?.brand) === brandKey('Sem marca'))) {
    rows = candidates;
  }
  if (rows.length === 0) {
    return blocked(key, null, brand ?? null, wantedCondition, 0, 0, null, 0,
      'walkin_measure_not_found');
  }
  if (rows.length !== 1) {
    return blocked(key, rows[0]?.measure ?? null, brand ?? null, wantedCondition,
      0, 0, null, rows.length,
      'walkin_stock_ambiguous');
  }

  const row = rows[0]!;
  const quantity = Number(row.quantity_on_hand);
  const reserved = Number(row.quantity_reserved ?? 0);
  const safeQuantity = Number.isFinite(quantity) ? quantity : 0;
  const safeReserved = Number.isFinite(reserved) ? reserved : 0;
  const available = Math.max(safeQuantity - safeReserved, 0);
  if (!Number.isFinite(quantity) || !Number.isFinite(reserved) || available <= 0) {
    return blocked(key, row.measure, row.brand ?? null, wantedCondition,
      safeQuantity, safeReserved, parseCost(row.unit_cost), 1,
      'walkin_stock_insufficient');
  }

  const unitCost = parseCost(row.unit_cost);
  if (unitCost === null || unitCost <= 0) {
    return blocked(key, row.measure, row.brand ?? null, wantedCondition,
      safeQuantity, safeReserved, unitCost, 1,
      'walkin_cost_missing');
  }

  return {
    key,
    measure: row.measure,
    brand: row.brand ?? null,
    tire_condition: wantedCondition,
    quantity_on_hand: safeQuantity,
    quantity_reserved: safeReserved,
    quantity_available: available,
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
  brand: string | null,
  tireCondition: TireCondition | null,
  quantity: number,
  reserved: number,
  unitCost: number | null,
  rowsCount: number,
  reason: MatrizStockBlockReason,
): MatrizStockState {
  return {
    key,
    measure,
    brand,
    tire_condition: tireCondition,
    quantity_on_hand: quantity,
    quantity_reserved: reserved,
    quantity_available: Math.max(quantity - reserved, 0),
    unit_cost: unitCost,
    rows_count: rowsCount,
    sellable: false,
    block_reason: reason,
  };
}

function brandKey(value: string | null | undefined): string {
  return (value ?? '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '');
}

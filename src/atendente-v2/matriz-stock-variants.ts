import type { PoolClient } from 'pg';
import type { TireCondition } from '../shared/tire-condition.js';

export interface MatrizProductStockSpec {
  product_id: string;
  tire_size: string | null;
  brand: string | null;
  tire_condition: TireCondition;
}

export interface MatrizOfficialStockRow {
  measure: string;
  brand: string;
  tire_condition: TireCondition;
  quantity_on_hand: number | string;
  unit_cost: number | string | null;
}

export function stockBrandKey(value: string | null | undefined): string {
  return (value ?? '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export async function loadMatrizProductStockSpecs(
  client: PoolClient,
  environment: 'prod' | 'test',
  productIds: string[],
): Promise<MatrizProductStockSpec[]> {
  if (!productIds.length) return [];
  const result = await client.query<MatrizProductStockSpec>(
    `SELECT ts.product_id,ts.tire_size,p.brand,p.tire_condition
       FROM commerce.tire_specs ts
       JOIN commerce.products p ON p.id=ts.product_id AND p.environment=ts.environment
      WHERE ts.environment=$1 AND ts.product_id=ANY($2)`,
    [environment, productIds],
  );
  return result.rows;
}

export async function loadMatrizOfficialStock(
  client: PoolClient,
  environment: 'prod' | 'test',
  lock = false,
): Promise<MatrizOfficialStockRow[]> {
  const result = await client.query<MatrizOfficialStockRow>(
    `SELECT measure,brand,tire_condition,quantity_on_hand,unit_cost
       FROM commerce.wholesale_stock
      WHERE environment=$1
      ${lock ? 'ORDER BY measure,brand,tire_condition FOR UPDATE' : ''}`,
    [environment],
  );
  return result.rows;
}

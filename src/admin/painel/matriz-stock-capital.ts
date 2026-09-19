import type { Pool } from 'pg';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';

/** Posição física atual pelo custo médio, compartilhada pelo Financeiro web e app. */
export async function getMatrizStockCapital(environment = env.FAREJADOR_ENV, db: Pool = pool) {
  const result = await db.query<{ capital: string; pneus: number; sem_custo: number }>(
    `SELECT COALESCE(SUM(quantity_on_hand * unit_cost), 0)::text AS capital,
            COALESCE(SUM(quantity_on_hand), 0)::int AS pneus,
            COALESCE(SUM(quantity_on_hand) FILTER (WHERE unit_cost IS NULL), 0)::int AS sem_custo
       FROM commerce.wholesale_stock WHERE environment = $1`, [environment],
  );
  return result.rows[0]!;
}

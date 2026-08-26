import type { Pool, PoolClient } from 'pg';
import type { TireCondition } from '../../shared/tire-condition.js';

/** Atualiza o mínimo agregado e espelha a coluna legada sem tocar saldos/custos. */
export async function setWholesaleReplenishmentPolicy(
  db: Pool | PoolClient,
  input: {
    environment: 'prod' | 'test'; measure: string; tireCondition: TireCondition;
    minQuantity: number | null; actorLabel?: string | null;
  },
): Promise<void> {
  const params = [input.environment, input.measure, input.tireCondition] as const;
  if (input.minQuantity === null) {
    await db.query(
      `DELETE FROM commerce.wholesale_replenishment_policies
        WHERE environment=$1 AND measure=$2 AND tire_condition=$3`,
      [...params],
    );
  } else {
    await db.query(
      `INSERT INTO commerce.wholesale_replenishment_policies
         (environment,measure,tire_condition,min_quantity,updated_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (environment,measure,tire_condition) DO UPDATE SET
         min_quantity=EXCLUDED.min_quantity,updated_by=EXCLUDED.updated_by`,
      [...params, input.minQuantity, input.actorLabel?.trim() || null],
    );
  }
  await db.query(
    `UPDATE commerce.wholesale_stock SET min_quantity=$4
      WHERE environment=$1 AND measure=$2 AND tire_condition=$3
        AND min_quantity IS DISTINCT FROM $4`,
    [...params, input.minQuantity],
  );
}

import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { requireTireCondition, type TireCondition } from '../../shared/tire-condition.js';
import { canonicalCatalogBrand } from './catalog-brand.js';
import { postMatrizInventoryAdjustmentsByMovementRef } from './matriz-ledger-inventory.js';
import { deleteWholesaleStock } from './queries-galpao.js';
import { setGalpaoMovContext } from './queries-galpao-movimentos.js';
import {
  beginIntegrityOperation, completeIntegrityOperation, operationFingerprint,
  recordIntegrityEvent,
} from './stage5-integrity.js';

export interface DeleteWholesaleStockInput {
  measure: string;
  brand: string;
  tire_condition: TireCondition | string;
  reason: string;
  idempotency_key: string;
  actor_label?: string | null;
  environment?: 'prod' | 'test';
}

/** Remove uma variante inteira sem apagar a trilha física nem o efeito financeiro. */
export async function deleteWholesaleStockComRotulo(
  input: DeleteWholesaleStockInput,
  dbPool: Pool = defaultPool,
): Promise<void> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const measure = input.measure.trim();
  const brand = canonicalCatalogBrand(input.brand) ?? 'Sem marca';
  const tireCondition = requireTireCondition(input.tire_condition);
  const reason = input.reason.trim();
  if (!measure) throw new Error('measure_required');
  if (reason.length < 2) throw new Error('reason_required');
  const operation = {
    environment,
    domain: 'stock.remove',
    idempotencyKey: input.idempotency_key,
    fingerprint: operationFingerprint({ measure, brand, tire_condition: tireCondition, reason }),
  };
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const started = await beginIntegrityOperation<{ removed: true }>(client, operation);
    if (started.replayed) {
      await client.query('COMMIT');
      return;
    }
    const current = await client.query<{
      id: string; quantity_on_hand: number; quantity_reserved: number; unit_cost: string;
    }>(
      `SELECT id,quantity_on_hand,quantity_reserved,unit_cost::text
         FROM commerce.wholesale_stock
        WHERE environment=$1 AND measure=$2 AND brand=$3 AND tire_condition=$4
        FOR UPDATE`,
      [environment, measure, brand, tireCondition],
    );
    const before = current.rows[0];
    if (!before) throw new Error('measure_not_found');
    if (Number(before.quantity_reserved) > 0) throw new Error('stock_has_reservations');
    await setGalpaoMovContext(client, {
      source: 'remocao', nature: 'inventory_writeoff', reason,
      ref: operation.idempotencyKey,
    });
    await deleteWholesaleStock(measure, brand, tireCondition, environment, client);
    await recordIntegrityEvent(client, {
      environment, domain: 'stock', entityTable: 'commerce.wholesale_stock',
      entityId: before.id, eventType: 'stock_variant_removed',
      actorLabel: input.actor_label, idempotencyKey: operation.idempotencyKey,
      before: {
        measure, brand, tire_condition: tireCondition,
        quantity_on_hand: Number(before.quantity_on_hand),
        quantity_reserved: Number(before.quantity_reserved),
        unit_cost: before.unit_cost,
      },
      after: { removed: true, reason },
    });
    await completeIntegrityOperation(
      client, operation, 'commerce.wholesale_stock', before.id, { removed: true },
    );
    await postMatrizInventoryAdjustmentsByMovementRef(
      client, environment, operation.idempotencyKey, input.actor_label,
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

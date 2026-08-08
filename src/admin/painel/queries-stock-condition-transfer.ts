import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import {
  requireTireCondition,
  type TireCondition,
} from '../../shared/tire-condition.js';
import { canonicalCatalogBrand } from './catalog-brand.js';
import { setGalpaoMovContext } from './queries-galpao-movimentos.js';
import {
  beginIntegrityOperation,
  completeIntegrityOperation,
  integrityResult,
  operationFingerprint,
  recordIntegrityEvent,
} from './stage5-integrity.js';
import { postMatrizInventoryAdjustmentsByMovementRef } from './matriz-ledger-inventory.js';

interface StockVariant {
  id: string;
  measure: string;
  brand: string;
  tire_condition: TireCondition;
  quantity_on_hand: number;
  quantity_reserved: number;
  unit_cost: string;
  min_quantity: number | null;
  notes: string | null;
  tire_width_mm: number | null;
  tire_aspect_ratio: number | null;
  tire_rim_diameter: number | null;
}

export interface TransferStockConditionResult {
  measure: string;
  brand: string;
  from_condition: TireCondition;
  to_condition: TireCondition;
  transferred_quantity: number;
  source_quantity: number;
  target_quantity: number;
  target_unit_cost: number;
}

export async function transferWholesaleStockCondition(
  input: {
    measure: string;
    brand: string;
    from_condition: TireCondition | string;
    to_condition: TireCondition | string;
    quantity: number;
    reason: string;
    idempotency_key: string;
    actor_label?: string | null;
    environment?: 'prod' | 'test';
  },
  dbPool: Pool = defaultPool,
): Promise<TransferStockConditionResult> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const measure = input.measure.trim();
  const brand = canonicalCatalogBrand(input.brand) ?? 'Sem marca';
  const fromCondition = requireTireCondition(input.from_condition);
  const toCondition = requireTireCondition(input.to_condition);
  const reason = input.reason.trim();
  if (!measure) throw new Error('measure_required');
  if (fromCondition === toCondition) throw new Error('condition_transfer_same');
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw new Error('quantity_invalid');
  }
  if (reason.length < 2) throw new Error('reason_required');

  const operation = {
    environment,
    domain: 'stock.condition_transfer',
    idempotencyKey: input.idempotency_key,
    fingerprint: operationFingerprint({
      measure, brand, from_condition: fromCondition,
      to_condition: toCondition, quantity: input.quantity, reason,
    }),
  };
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const started = await beginIntegrityOperation<TransferStockConditionResult>(
      client, operation,
    );
    if (started.replayed) {
      await client.query('COMMIT');
      return started.result;
    }

    const locked = await client.query<StockVariant>(
      `SELECT id,measure,brand,tire_condition,quantity_on_hand,quantity_reserved,unit_cost::text,
              min_quantity,notes,tire_width_mm,tire_aspect_ratio,tire_rim_diameter
         FROM commerce.wholesale_stock
        WHERE environment=$1 AND measure=$2 AND brand=$3
          AND tire_condition IN ($4,$5)
        ORDER BY tire_condition
        FOR UPDATE`,
      [environment, measure, brand, fromCondition, toCondition],
    );
    const source = locked.rows.find((row) => row.tire_condition === fromCondition);
    const targetBefore = locked.rows.find((row) => row.tire_condition === toCondition);
    if (!source) throw new Error('condition_transfer_source_not_found');
    const available = Number(source.quantity_on_hand) - Number(source.quantity_reserved ?? 0);
    if (available < input.quantity) {
      throw new Error(`condition_transfer_insufficient:${available}`);
    }

    await setGalpaoMovContext(client, {
      source: 'correcao_condicao',
      nature: 'condition_transfer',
      reason,
      ref: operation.idempotencyKey,
    });
    const sourceAfter = await client.query<{ quantity_on_hand: number }>(
      `UPDATE commerce.wholesale_stock
          SET quantity_on_hand=quantity_on_hand-$5
        WHERE environment=$1 AND measure=$2 AND brand=$3 AND tire_condition=$4
        RETURNING quantity_on_hand`,
      [environment, measure, brand, fromCondition, input.quantity],
    );
    const targetAfter = await client.query<{
      id: string; quantity_on_hand: number; unit_cost: string;
    }>(
      `INSERT INTO commerce.wholesale_stock (
         environment,measure,brand,tire_condition,quantity_on_hand,unit_cost,
         min_quantity,notes,tire_width_mm,tire_aspect_ratio,tire_rim_diameter
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (environment,measure,brand,tire_condition) DO UPDATE SET
         unit_cost=round(
           (commerce.wholesale_stock.quantity_on_hand*commerce.wholesale_stock.unit_cost
             + EXCLUDED.quantity_on_hand*EXCLUDED.unit_cost)
           / NULLIF(commerce.wholesale_stock.quantity_on_hand
             + EXCLUDED.quantity_on_hand,0),2),
         quantity_on_hand=commerce.wholesale_stock.quantity_on_hand
           + EXCLUDED.quantity_on_hand
       RETURNING id,quantity_on_hand,unit_cost::text`,
      [
        environment, source.measure, source.brand, toCondition, input.quantity,
        Number(source.unit_cost), source.min_quantity, source.notes,
        source.tire_width_mm, source.tire_aspect_ratio, source.tire_rim_diameter,
      ],
    );
    const target = targetAfter.rows[0]!;
    const result = integrityResult<TransferStockConditionResult>({
      measure, brand, from_condition: fromCondition, to_condition: toCondition,
      transferred_quantity: input.quantity,
      source_quantity: Number(sourceAfter.rows[0]!.quantity_on_hand),
      target_quantity: Number(target.quantity_on_hand),
      target_unit_cost: Number(target.unit_cost),
    });
    await recordIntegrityEvent(client, {
      environment, domain: 'stock', entityTable: 'commerce.wholesale_stock',
      entityId: target.id, eventType: 'condition_transferred',
      actorLabel: input.actor_label, idempotencyKey: operation.idempotencyKey,
      before: {
        source, target: targetBefore ?? null,
      },
      after: {
        ...result, reason,
      },
    });
    await completeIntegrityOperation(
      client, operation, 'commerce.wholesale_stock', target.id, result,
    );
    await postMatrizInventoryAdjustmentsByMovementRef(
      client, environment, operation.idempotencyKey, input.actor_label,
    );
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

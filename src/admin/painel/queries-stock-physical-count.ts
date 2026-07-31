import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import {
  beginIntegrityOperation, completeIntegrityOperation, integrityResult,
  operationFingerprint, recordIntegrityEvent,
} from './stage5-integrity.js';
import { setGalpaoMovContext } from './queries-galpao-movimentos.js';
import { postMatrizInventoryAdjustmentsByMovementRef } from './matriz-ledger-inventory.js';
import {
  requireTireCondition,
  type TireCondition,
} from '../../shared/tire-condition.js';

interface StockCountRow {
  id: string;
  measure: string;
  brand: string;
  tire_condition: TireCondition;
  quantity_on_hand: number;
  unit_cost: string | null;
}

export interface MatrizPhysicalStockCountResult {
  checked: number;
  changed: number;
  gains: number;
  losses: number;
  differences: Array<{
    measure: string;
    brand: string;
    tire_condition: TireCondition;
    previous_quantity: number;
    counted_quantity: number;
    difference: number;
  }>;
}

export async function applyMatrizPhysicalStockCount(
  input: {
    rows: Array<{ measure: string; brand: string;
      tire_condition: TireCondition | string; counted_quantity: number }>;
    reason: string;
    idempotency_key: string;
    actor_label?: string | null;
    environment?: 'prod' | 'test';
  },
  dbPool: Pool = defaultPool,
): Promise<MatrizPhysicalStockCountResult> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const reason = input.reason.trim();
  if (reason.length < 2) throw new Error('reason_required');
  if (!input.rows.length) throw new Error('physical_count_rows_required');
  const normalized = input.rows.map((row) => ({
    measure: row.measure.trim(),
    brand: row.brand?.trim() || 'Sem marca',
    tire_condition: requireTireCondition(row.tire_condition),
    counted_quantity: row.counted_quantity,
  })).sort((a, b) => `${a.measure}\u0000${a.brand}\u0000${a.tire_condition}`
    .localeCompare(`${b.measure}\u0000${b.brand}\u0000${b.tire_condition}`));
  if (normalized.some((row) => !row.measure || !row.brand
    || !Number.isInteger(row.counted_quantity) || row.counted_quantity < 0)) {
    throw new Error('physical_count_invalid');
  }
  if (new Set(normalized.map((row) =>
    `${row.measure}\u0000${row.brand}\u0000${row.tire_condition}`)).size
    !== normalized.length) {
    throw new Error('physical_count_duplicate_measure');
  }
  const operation = {
    environment, domain: 'stock.physical_count',
    idempotencyKey: input.idempotency_key,
    fingerprint: operationFingerprint({ rows: normalized, reason }),
  };
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const started = await beginIntegrityOperation<MatrizPhysicalStockCountResult>(
      client, operation,
    );
    if (started.replayed) {
      await client.query('COMMIT');
      return started.result;
    }
    const current = await client.query<StockCountRow>(
      `SELECT id,measure,brand,tire_condition,quantity_on_hand,unit_cost::text
         FROM commerce.wholesale_stock
        WHERE environment=$1
          AND (measure,brand,tire_condition) IN (
            SELECT x.measure,x.brand,x.tire_condition
              FROM jsonb_to_recordset($2::jsonb)
                AS x(measure text,brand text,tire_condition text)
          )
        ORDER BY measure,brand,tire_condition FOR UPDATE`,
      [environment, JSON.stringify(normalized.map(
        ({ measure, brand, tire_condition }) => ({ measure, brand, tire_condition }),
      ))],
    );
    if (current.rows.length !== normalized.length) {
      throw new Error('physical_count_measure_not_found');
    }
    const byVariant = new Map(current.rows.map((row) => [
      `${row.measure}\u0000${row.brand}\u0000${row.tire_condition}`, row,
    ]));
    // O trigger financeiro 0147 reconhece `definir` como contagem de inventário.
    // Mantemos esse contrato histórico para que código novo funcione antes e depois
    // do deploy, diferenciando a operação pelo motivo e pelo evento de auditoria.
    await setGalpaoMovContext(client, {
      source: 'definir', nature: 'inventory_count',
      reason: `Contagem física: ${reason}`, ref: operation.idempotencyKey,
    });
    const differences: MatrizPhysicalStockCountResult['differences'] = [];
    for (const counted of normalized) {
      const before = byVariant.get(
        `${counted.measure}\u0000${counted.brand}\u0000${counted.tire_condition}`,
      )!;
      const difference = counted.counted_quantity - Number(before.quantity_on_hand);
      if (difference !== 0) {
        await client.query(
          `UPDATE commerce.wholesale_stock SET quantity_on_hand=$3
            WHERE environment=$1 AND id=$2`,
          [environment, before.id, counted.counted_quantity],
        );
        differences.push({
          measure: counted.measure,
          brand: counted.brand,
          tire_condition: counted.tire_condition,
          previous_quantity: Number(before.quantity_on_hand),
          counted_quantity: counted.counted_quantity,
          difference,
        });
      }
      await recordIntegrityEvent(client, {
        environment, domain: 'stock',
        entityTable: 'commerce.wholesale_stock', entityId: before.id,
        eventType: 'physical_count_confirmed', actorLabel: input.actor_label,
        idempotencyKey: operation.idempotencyKey,
        before: {
          measure: before.measure, brand: before.brand,
          tire_condition: before.tire_condition,
          quantity_on_hand: Number(before.quantity_on_hand),
          unit_cost: before.unit_cost,
        },
        after: {
          measure: before.measure, brand: before.brand,
          tire_condition: before.tire_condition,
          counted_quantity: counted.counted_quantity,
          difference, reason,
        },
      });
    }
    await postMatrizInventoryAdjustmentsByMovementRef(
      client, environment, operation.idempotencyKey, input.actor_label,
    );
    const result = integrityResult({
      checked: normalized.length,
      changed: differences.length,
      gains: differences.filter((row) => row.difference > 0)
        .reduce((sum, row) => sum + row.difference, 0),
      losses: differences.filter((row) => row.difference < 0)
        .reduce((sum, row) => sum + Math.abs(row.difference), 0),
      differences,
    });
    await completeIntegrityOperation(
      client, operation, 'commerce.wholesale_stock', current.rows[0]!.id, result,
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

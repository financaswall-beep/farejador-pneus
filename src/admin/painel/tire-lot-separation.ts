import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { setGalpaoMovContext } from './queries-galpao-movimentos.js';
import { beginIntegrityOperation, completeIntegrityOperation, operationFingerprint, recordIntegrityEvent } from './stage5-integrity.js';

export const lotSeparationSchema = z.object({
  stock_id: z.string().uuid(), description: z.string().trim().min(1).max(200),
  quantity: z.number().int().min(1).max(100000), reason: z.string().trim().min(5).max(500),
  idempotency_key: z.string().min(8).max(200),
}).strict();

export async function separateTireLot(input: z.infer<typeof lotSeparationSchema>, actor: string, db: Pool = defaultPool) {
  const data = lotSeparationSchema.parse(input);
  const environment = env.FAREJADOR_ENV;
  const operation = { environment, domain: 'tire-lot-separation', idempotencyKey: data.idempotency_key,
    fingerprint: operationFingerprint(data) };
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const replay = await beginIntegrityOperation<{ id: string; lot_code: string }>(client, operation);
    if (replay.replayed) { await client.query('COMMIT'); return replay.result; }
    const source = await client.query(`SELECT id,measure,brand,tire_condition,quantity_on_hand,
      quantity_reserved,unit_cost,
      round(unit_cost*quantity_on_hand,2)-round(unit_cost*(quantity_on_hand-$3),2) transfer_cost
      FROM commerce.wholesale_stock WHERE environment=$1 AND id=$2 FOR UPDATE`,
    [environment, data.stock_id, data.quantity]);
    const stock = source.rows[0];
    if (!stock) throw new Error('lot_source_not_found');
    if (stock.quantity_on_hand - stock.quantity_reserved < data.quantity) throw new Error('lot_source_insufficient');
    if (stock.unit_cost === null) throw new Error('lot_source_cost_missing');
    const id = randomUUID();
    await setGalpaoMovContext(client, { source: 'separacao_lote', ref: id, reason: data.reason });
    await client.query(`UPDATE commerce.wholesale_stock SET quantity_on_hand=quantity_on_hand-$3
      WHERE environment=$1 AND id=$2`, [environment, data.stock_id, data.quantity]);
    const result = await client.query<{ id: string; lot_code: string }>(`INSERT INTO commerce.tire_lots
      (id,environment,description,origin_type,origin_stock_id,origin_snapshot,ordered_quantity,accepted_quantity,
       products_amount,allocated_cost,quantity_on_hand,remaining_cost)
      VALUES ($1,$2,$3,'separation',$4,$5::jsonb,$6,$6,$7,$7,$6,$7)
      RETURNING id,'LT-'||lpad(lot_number::text,6,'0') lot_code`,
    [id, environment, data.description, stock.id, JSON.stringify({ ...stock, reason: data.reason }), data.quantity, stock.transfer_cost]);
    await client.query(`INSERT INTO commerce.tire_lot_movements
      (environment,lot_id,source,quantity_delta,cost_delta,occurred_at,created_by)
      VALUES ($1,$2,'separation_in',$3,$4,now(),$5)`, [environment, id, data.quantity, stock.transfer_cost, actor]);
    await recordIntegrityEvent(client, { environment, domain: operation.domain, entityTable: 'commerce.tire_lots',
      entityId: id, eventType: 'separated', actorLabel: actor, idempotencyKey: operation.idempotencyKey,
      before: stock, after: { quantity: data.quantity, cost: stock.transfer_cost } });
    await completeIntegrityOperation(client, operation, 'commerce.tire_lots', id, result.rows[0]);
    await client.query('COMMIT');
    return result.rows[0]!;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { setGalpaoMovContext } from './queries-galpao-movimentos.js';
import { beginIntegrityOperation, completeIntegrityOperation, operationFingerprint, recordIntegrityEvent } from './stage5-integrity.js';
import { buildTransferPlan, lotSnapshot, stockSnapshot, lockTireTransfers, type Snapshot, type TransferInput, type TransferPlan } from './tire-transfer-plan.js';
import { postLotLoss } from './tire-transfer-loss.js';

export const confirmTransferSchema = z.object({ input: z.unknown(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  idempotency_key: z.string().trim().min(8).max(200) }).strict();
export const reverseTransferSchema = z.object({ id: z.string().uuid(), reason: z.string().trim().min(5).max(500),
  idempotency_key: z.string().trim().min(8).max(200) }).strict();
type Result = { id: string; lot_id: string; lot_code: string; cost: string; quantity: number };
export async function previewTireTransfer(input: TransferInput, db: Pool = defaultPool) {
  const client = await db.connect();
  try { await client.query('BEGIN'); return await buildTransferPlan(client, env.FAREJADOR_ENV, input); }
  finally { await client.query('ROLLBACK'); client.release(); }
}
export async function writeStock(client: PoolClient, environment: string, item: Snapshot,
  existing: Snapshot | null): Promise<Snapshot> {
  let id = existing?.id;
  if (id) {
    await client.query(`UPDATE commerce.wholesale_stock SET quantity_on_hand=$3,unit_cost=$4,
      vehicle_type=$5 WHERE environment=$1 AND id=$2`,
    [environment, id, item.quantity_on_hand, item.unit_cost, item.vehicle_type]);
  } else {
    const inserted = await client.query(`INSERT INTO commerce.wholesale_stock
      (environment,measure,brand,tire_condition,vehicle_type,quantity_on_hand,unit_cost,
       tire_width_mm,tire_aspect_ratio,tire_rim_diameter)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id`,
    [environment, item.measure, item.brand, item.tire_condition, item.vehicle_type,
      item.quantity_on_hand, item.unit_cost, item.tire_width_mm, item.tire_aspect_ratio, item.tire_rim_diameter]);
    if (!inserted.rowCount) throw Error('transfer_preview_changed');
    id = inserted.rows[0].id;
  }
  return (await stockSnapshot(client, environment, id))!;
}
export async function recordTransfer(client: PoolClient, environment: string, id: string, kind: string,
  lot: Snapshot, before: Snapshot | null, quantity: number, cost: string, reason: string, actor: string, reversal?: string) {
  await client.query(`INSERT INTO commerce.tire_stock_transfers
    (id,environment,kind,lot_id,quantity,cost,reason,created_by,before_lot,after_lot,reversal_of)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11)`,
  [id, environment, kind, lot.id, quantity, cost, reason, actor, JSON.stringify(before), JSON.stringify(lot), reversal ?? null]);
}
export async function recordItem(client: PoolClient, environment: string, id: string,
  item: { quantity: number; cost: string; product_id: string | null; before: Snapshot | null }, after: Snapshot) {
  await client.query(`INSERT INTO commerce.tire_stock_transfer_items
    (environment,transfer_id,stock_id,product_id,quantity,cost,before_stock,after_stock)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
  [environment, id, after.id, item.product_id, item.quantity, item.cost, JSON.stringify(item.before), JSON.stringify(after)]);
}
async function applyPlan(client: PoolClient, plan: TransferPlan, actor: string, id: string) {
  const environment = env.FAREJADOR_ENV;
  await setGalpaoMovContext(client, { source: 'transferencia_lote', ref: id, reason: plan.input.reason });
  let lot: Snapshot;
  if (plan.input.kind === 'to_lot') {
    const stock = plan.items[0]!.before!;
    const inserted = await client.query(`INSERT INTO commerce.tire_lots
      (environment,description,origin_type,origin_stock_id,origin_snapshot,ordered_quantity,accepted_quantity,
       products_amount,allocated_cost,quantity_on_hand,remaining_cost,vehicle_type)
      VALUES ($1,$2,'separation',$3,$4::jsonb,$5,$5,$6,$6,$5,$6,$7) RETURNING id`,
    [environment, plan.input.description, stock.id, JSON.stringify({ ...stock, reason: plan.input.reason }),
      plan.quantity, plan.cost, stock.vehicle_type]);
    lot = await lotSnapshot(client, environment, inserted.rows[0].id);
  } else {
    await client.query(`UPDATE commerce.tire_lots SET quantity_on_hand=$3,remaining_cost=$4
      WHERE environment=$1 AND id=$2`, [environment, plan.lot!.id, plan.remaining_quantity, plan.remaining_cost]);
    lot = await lotSnapshot(client, environment, plan.lot!.id);
  }
  await recordTransfer(client, environment, id, plan.input.kind, lot, plan.lot,
    plan.quantity, plan.cost, plan.input.reason, actor);
  for (const item of plan.items) await recordItem(client, environment, id, item,
    await writeStock(client, environment, item.after, item.before));
  const toLot = plan.input.kind === 'to_lot';
  const movement = await client.query(`INSERT INTO commerce.tire_lot_movements
    (environment,lot_id,source,quantity_delta,cost_delta,occurred_at,created_by,transfer_id)
    VALUES ($1,$2,$3,$4,$5,now(),$6,$7) RETURNING id`, [environment, lot.id,
    toLot ? 'separation_in' : plan.input.kind === 'loss' ? 'triage_loss' : 'transfer_out',
    toLot ? plan.quantity : -plan.quantity, toLot ? plan.cost : '-' + plan.cost, actor, toLot ? null : id]);
  if (plan.input.kind === 'loss') await postLotLoss(client, environment, id, movement.rows[0].id,
    plan.lot!, lot, plan.cost, plan.quantity, actor, plan.input.reason);
  return { id, lot_id: lot.id, lot_code: 'LT-' + String(lot.lot_number).padStart(6, '0'), cost: plan.cost, quantity: plan.quantity };
}
export async function confirmTireTransfer(input: TransferInput, fingerprint: string | undefined,
  key: string, actor: string, db: Pool = defaultPool): Promise<Result> {
  const operation = { environment: env.FAREJADOR_ENV, domain: 'tire_transfer.create', idempotencyKey: key,
    fingerprint: operationFingerprint({ input, fingerprint: fingerprint ?? null }) };
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const replay = await beginIntegrityOperation<Result>(client, operation);
    if (replay.replayed) { await client.query('COMMIT'); return replay.result; }
    const plan = await buildTransferPlan(client, env.FAREJADOR_ENV, input);
    if (fingerprint && fingerprint !== plan.fingerprint) throw Error('transfer_preview_changed');
    const result = await applyPlan(client, plan, actor, randomUUID());
    await recordIntegrityEvent(client, { environment: env.FAREJADOR_ENV, domain: 'tire_transfer',
      entityTable: 'commerce.tire_stock_transfers', entityId: result.id, eventType: input.kind,
      actorLabel: actor, idempotencyKey: key, after: result });
    await completeIntegrityOperation(client, operation, 'commerce.tire_stock_transfers', result.id, result);
    await client.query('COMMIT'); return result;
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

export async function reverseTireTransfer(raw: z.infer<typeof reverseTransferSchema>, actor: string, db: Pool = defaultPool) {
  const input = reverseTransferSchema.parse(raw), environment = env.FAREJADOR_ENV;
  const operation = { environment, domain: 'tire_transfer.reverse', idempotencyKey: input.idempotency_key,
    fingerprint: operationFingerprint({ id: input.id, reason: input.reason }) };
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const replay = await beginIntegrityOperation<Result>(client, operation);
    if (replay.replayed) { await client.query('COMMIT'); return replay.result; }
    await lockTireTransfers(client, environment);
    const r = await client.query(`SELECT * FROM commerce.tire_stock_transfers WHERE environment=$1 AND id=$2 FOR UPDATE`, [environment, input.id]);
    const t = r.rows[0];
    if (!t || t.kind === 'reversal') throw Error('transfer_not_found');
    if ((await client.query(`SELECT 1 FROM commerce.tire_stock_transfers WHERE environment=$1 AND reversal_of=$2`, [environment, t.id])).rowCount) throw Error('transfer_already_reversed');
    const lot = await lotSnapshot(client, environment, t.lot_id);
    if (lot.inventory_revision !== t.after_lot.inventory_revision || lot.quantity_reserved !== 0) throw Error('transfer_has_later_movements');
    const items = (await client.query(`SELECT * FROM commerce.tire_stock_transfer_items
      WHERE environment=$1 AND transfer_id=$2 ORDER BY stock_id`, [environment, t.id])).rows;
    for (const item of items) {
      const stock = await stockSnapshot(client, environment, item.stock_id);
      if (!stock || stock.inventory_revision !== item.after_stock.inventory_revision || stock.quantity_reserved !== 0) throw Error('transfer_has_later_movements');
    }
    const id = randomUUID();
    await setGalpaoMovContext(client, { source: 'estorno_transferencia_lote', ref: id, reason: input.reason });
    await client.query(`UPDATE commerce.tire_lots SET quantity_on_hand=$3,remaining_cost=$4
      WHERE environment=$1 AND id=$2`, [environment, t.lot_id, t.before_lot?.quantity_on_hand ?? 0, t.before_lot?.remaining_cost ?? '0.00']);
    const after = await lotSnapshot(client, environment, t.lot_id);
    await recordTransfer(client, environment, id, 'reversal', after, lot, t.quantity, t.cost, input.reason, actor, t.id);
    for (const item of items) {
      const target = item.before_stock ?? { ...item.after_stock, quantity_on_hand: 0, unit_cost: '0.000000' };
      const written = await writeStock(client, environment, target, item.after_stock);
      await recordItem(client, environment, id, { ...item, before: item.after_stock }, written);
    }
    const movement = await client.query(`INSERT INTO commerce.tire_lot_movements
      (environment,lot_id,source,quantity_delta,cost_delta,occurred_at,created_by,transfer_id)
      VALUES ($1,$2,'transfer_reversal',$3,$4,now(),$5,$6) RETURNING id`,
    [environment, t.lot_id, t.kind === 'to_lot' ? -t.quantity : t.quantity,
      t.kind === 'to_lot' ? '-' + t.cost : t.cost, actor, id]);
    if (t.kind === 'loss') await postLotLoss(client, environment, id, movement.rows[0].id,
      lot, after, t.cost, t.quantity, actor, input.reason, t.id);
    const result = { id, lot_id: t.lot_id, lot_code: 'LT-' + String(lot.lot_number).padStart(6, '0'), cost: t.cost, quantity: t.quantity };
    await recordIntegrityEvent(client, { environment, domain: 'tire_transfer', entityTable: 'commerce.tire_stock_transfers',
      entityId: id, eventType: 'reversed', actorLabel: actor, idempotencyKey: input.idempotency_key, after: result });
    await completeIntegrityOperation(client, operation, 'commerce.tire_stock_transfers', id, result);
    await client.query('COMMIT'); return result;
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { PartnerContext } from './auth.js';
import { withPartnerContext } from './db.js';
import type { OperationItemType } from './operation-stock.js';

export type OperationStockCountReason = 'rotina' | 'inventario' | 'divergencia' | 'outro';

export interface OperationStockCountInput {
  stock_id: string;
  counted_quantity: number;
  reason: OperationStockCountReason;
  reason_detail?: string | null;
  idempotency_key: string;
}

export interface OperationStockCountBatchInput {
  batch_id: string;
  items: OperationStockCountInput[];
}

interface StockSnapshot {
  id: string;
  quantity_on_hand: number | null;
  is_tracked: boolean;
  item_type: OperationItemType;
  updated_at: string;
}

interface CountRequestResult {
  id: string;
  stock_id: string;
  status: 'pending';
  created_at: string;
  quantity_snapshot: number | null;
}

export class StockUnavailableForCountError extends Error {
  readonly code = 'stock_unavailable_for_count';

  constructor() {
    super('stock_unavailable_for_count');
  }
}

function cleanDetail(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

async function selectSnapshots(
  client: PoolClient,
  ctx: PartnerContext,
  stockIds: string[],
): Promise<Map<string, StockSnapshot>> {
  const selected = await client.query<StockSnapshot>(
    `SELECT id, quantity_on_hand, is_tracked, item_type, updated_at
       FROM commerce.partner_stock_levels
      WHERE id=ANY($1::uuid[]) AND environment=$2 AND unit_id=$3
        AND deleted_at IS NULL
      FOR SHARE`,
    [stockIds, ctx.environment, ctx.unitId],
  );
  const snapshots = new Map(selected.rows.map((row) => [row.id, row]));
  const invalid = stockIds.some((id) => {
    const row = snapshots.get(id);
    return !row || !row.is_tracked || row.item_type === 'servico';
  });
  if (invalid) throw new StockUnavailableForCountError();
  return snapshots;
}

async function insertCount(
  client: PoolClient,
  ctx: PartnerContext,
  actorLabel: string,
  data: OperationStockCountInput,
  snapshot: StockSnapshot,
  batchId: string | null,
): Promise<CountRequestResult> {
  const values = [
    ctx.environment, ctx.unitId, data.stock_id, ctx.tokenId, actorLabel,
    snapshot.quantity_on_hand, snapshot.updated_at, data.counted_quantity,
    data.reason, cleanDetail(data.reason_detail), batchId, data.idempotency_key,
  ];
  const inserted = await client.query<CountRequestResult>(
    `INSERT INTO commerce.partner_stock_count_requests (
       environment, unit_id, stock_id, requested_by_token_id,
       requested_by_label, quantity_snapshot, stock_updated_at_snapshot,
       counted_quantity, reason, reason_detail, batch_id, idempotency_key
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (environment, unit_id, idempotency_key) DO NOTHING
     RETURNING id, stock_id, status, created_at, quantity_snapshot`,
    values,
  );
  if (inserted.rows[0]) return inserted.rows[0];
  const existing = await client.query<CountRequestResult>(
    `SELECT id, stock_id, status, created_at, quantity_snapshot
       FROM commerce.partner_stock_count_requests
      WHERE environment=$1 AND unit_id=$2 AND idempotency_key=$3`,
    [ctx.environment, ctx.unitId, data.idempotency_key],
  );
  return existing.rows[0]!;
}

export async function requestOperationStockCount(
  ctx: PartnerContext,
  actorLabel: string,
  data: OperationStockCountInput,
): Promise<CountRequestResult> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const snapshots = await selectSnapshots(client, ctx, [data.stock_id]);
    return insertCount(client, ctx, actorLabel, data, snapshots.get(data.stock_id)!, null);
  });
}

export async function requestOperationStockCountBatch(
  ctx: PartnerContext,
  actorLabel: string,
  data: OperationStockCountBatchInput,
): Promise<{ batch_id: string; requests: CountRequestResult[] }> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const stockIds = data.items.map((item) => item.stock_id);
    const snapshots = await selectSnapshots(client, ctx, stockIds);
    const requests: CountRequestResult[] = [];
    for (const item of data.items) {
      requests.push(await insertCount(
        client, ctx, actorLabel, item, snapshots.get(item.stock_id)!, data.batch_id,
      ));
    }
    return { batch_id: data.batch_id, requests };
  });
}

export async function attachOperationStockCountEvidence(
  ctx: PartnerContext,
  requestId: string,
  photo: { bytes: Buffer; mime: 'image/jpeg'; sizeBytes: number },
): Promise<'attached' | 'existing' | 'not_found'> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO commerce.partner_stock_count_evidence (
         environment, unit_id, request_id, photo_bytes, photo_mime,
         photo_size_bytes, photo_sha256
       )
       SELECT r.environment, r.unit_id, r.id, $4, $5, $6, $7
         FROM commerce.partner_stock_count_requests r
        WHERE r.id=$1 AND r.environment=$2 AND r.unit_id=$3
          AND r.requested_by_token_id=$8 AND r.status='pending'
       ON CONFLICT (request_id) DO NOTHING
       RETURNING id`,
      [requestId, ctx.environment, ctx.unitId, photo.bytes, photo.mime,
        photo.sizeBytes, createHash('sha256').update(photo.bytes).digest('hex'), ctx.tokenId],
    );
    if (inserted.rows[0]) return 'attached';
    const existing = await client.query(
      `SELECT e.id
         FROM commerce.partner_stock_count_evidence e
         JOIN commerce.partner_stock_count_requests r
           ON r.id=e.request_id AND r.environment=e.environment AND r.unit_id=e.unit_id
        WHERE e.request_id=$1 AND e.environment=$2 AND e.unit_id=$3
          AND r.requested_by_token_id=$4`,
      [requestId, ctx.environment, ctx.unitId, ctx.tokenId],
    );
    return existing.rows[0] ? 'existing' : 'not_found';
  });
}

export async function getOperationStockCountEvidence(
  ctx: PartnerContext,
  requestId: string,
): Promise<{ bytes: Buffer; mime: string } | null> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const result = await client.query<{ photo_bytes: Buffer; photo_mime: string }>(
      `SELECT e.photo_bytes, e.photo_mime
         FROM commerce.partner_stock_count_evidence e
         JOIN commerce.partner_stock_count_requests r
           ON r.id=e.request_id AND r.environment=e.environment AND r.unit_id=e.unit_id
        WHERE e.request_id=$1 AND e.environment=$2 AND e.unit_id=$3`,
      [requestId, ctx.environment, ctx.unitId],
    );
    const row = result.rows[0];
    return row ? { bytes: row.photo_bytes, mime: row.photo_mime } : null;
  });
}

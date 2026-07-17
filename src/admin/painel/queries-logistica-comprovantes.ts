// Obra 300 (2026-07-05): fatia do banco da MATRIZ — comprovantes da rota + leitura por IA (0121/0122).
// VERBATIM das linhas 2879-3042 do queries.ts pré-obra (commit 2628748).
// Porta de entrada continua sendo ./queries.js (barrel) — importadores não mudam.
import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { normalizeBrazilianPhone } from '../../shared/phone.js';
import { applyWholesaleStockDecrement, applyWholesaleStockReturn } from './wholesale-stock.js';
import { resolveMeasureInCatalog } from './wholesale-catalog.js';
import { applyMatrizGalpaoDecrement, applyMatrizGalpaoReturn, applyMatrizRetailCostSnapshot } from '../../atendente-v2/wholesale-stock-read.js';
import { hashPassword } from '../../parceiro/password.js';

export interface MatrizReceiptUploadResult {
  receipt_id: string;
  ai_status: string;
  workflow_status: string;
  duplicate: boolean;
}

export class ReceiptExactDuplicateError extends Error {
  constructor(readonly duplicateTripNumber: string) {
    super('receipt_exact_duplicate');
    this.name = 'ReceiptExactDuplicateError';
  }
}

type DuplicateReceipt = MatrizReceiptUploadResult & {
  trip_id: string;
  trip_number: string;
};

async function findReceiptByHash(
  dbPool: Pool,
  environment: 'prod' | 'test',
  tripId: string,
  sha256Hex: string,
): Promise<DuplicateReceipt | null> {
  const found = await dbPool.query<DuplicateReceipt>(
    `SELECT r.id AS receipt_id,r.trip_id,t.trip_number,r.ai_status,r.workflow_status,
            true AS duplicate
       FROM commerce.matriz_trip_receipt_blobs b
       JOIN commerce.matriz_trip_receipts r
         ON r.environment=b.environment AND r.id=b.receipt_id
       JOIN commerce.matriz_delivery_trips t
         ON t.environment=r.environment AND t.id=r.trip_id
      WHERE b.environment=$1 AND b.content_sha256=decode($2,'hex')
      ORDER BY (r.trip_id=$3) DESC,b.dedup_enforced DESC
      LIMIT 1`,
    [environment, sha256Hex, tripId],
  );
  return found.rows[0] ?? null;
}

async function classifyDuplicate(
  dbPool: Pool, found: DuplicateReceipt, tripId: string,
  environment: 'prod' | 'test', sha256Hex: string,
  actorLabel?: string | null, uploadSource?: 'admin' | 'courier',
): Promise<MatrizReceiptUploadResult> {
  if (found.trip_id !== tripId) {
    await dbPool.query(`INSERT INTO audit.events
      (environment,domain,entity_table,entity_id,event_type,actor_label,
       idempotency_key,payload_after)
      VALUES ($1,'receipt','commerce.matriz_trip_receipts',$2,
        'duplicate_upload_blocked',$3,$4,$5::jsonb)`,
    [environment, found.receipt_id, actorLabel?.trim().slice(0, 200) || null,
      `receipt-duplicate:${sha256Hex}:${tripId}`,
      JSON.stringify({ upload_source: uploadSource ?? 'admin', attempted_trip_id: tripId,
        existing_trip_id: found.trip_id, existing_trip_number: found.trip_number })]);
    throw new ReceiptExactDuplicateError(found.trip_number);
  }
  return { receipt_id: found.receipt_id, ai_status: found.ai_status,
    workflow_status: found.workflow_status, duplicate: true };
}

export async function addMatrizTripReceipt(
  input: {
    trip_id: string;
    bytes: Buffer;
    mime: string;
    environment?: 'prod' | 'test';
    actor_label?: string | null;
    upload_source?: 'admin' | 'courier';
  },
  dbPool: Pool = defaultPool,
): Promise<MatrizReceiptUploadResult> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const aiStatus = env.MATRIZ_RECEIPT_AI ? 'pending' : 'skipped';
  const workflowStatus = env.MATRIZ_RECEIPT_AI ? 'uploaded' : 'review_required';
  const sha256Hex = createHash('sha256').update(input.bytes).digest('hex');
  const validTrip = await dbPool.query(`SELECT 1 FROM commerce.matriz_delivery_trips
    WHERE environment=$1 AND id=$2 AND deleted_at IS NULL`, [environment, input.trip_id]);
  if (!validTrip.rows[0]) throw new Error('trip_not_found');
  const existing = await findReceiptByHash(dbPool, environment, input.trip_id, sha256Hex);
  if (existing) return classifyDuplicate(dbPool, existing, input.trip_id, environment,
    sha256Hex, input.actor_label, input.upload_source);
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const trip = await client.query(
      `SELECT 1 FROM commerce.matriz_delivery_trips
        WHERE id = $2 AND environment = $1 AND deleted_at IS NULL`,
      [environment, input.trip_id],
    );
    if (!trip.rows[0]) throw new Error('trip_not_found');
    // Teto de comprovantes por rota (banca 07-03, anti-abuso de storage — blob é BYTEA).
    const count = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM commerce.matriz_trip_receipts WHERE trip_id = $1`,
      [input.trip_id],
    );
    if (Number(count.rows[0]!.n) >= 50) throw new Error('receipt_limit');
    const receipt = await client.query<{ id: string }>(
      `INSERT INTO commerce.matriz_trip_receipts
         (environment,trip_id,mime,size_bytes,ai_status,workflow_status)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [environment, input.trip_id, input.mime, input.bytes.length, aiStatus, workflowStatus],
    );
    const receiptId = receipt.rows[0]!.id;
    await client.query(
      `INSERT INTO commerce.matriz_trip_receipt_blobs (receipt_id, environment, bytes)
       VALUES ($1, $2, $3)`,
      [receiptId, environment, input.bytes],
    );
    await client.query('COMMIT');
    return { receipt_id: receiptId, ai_status: aiStatus,
      workflow_status: workflowStatus, duplicate: false };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    if ((err as { code?: string })?.code === '23505') {
      const raced = await findReceiptByHash(dbPool, environment, input.trip_id, sha256Hex);
      if (raced) return classifyDuplicate(dbPool, raced, input.trip_id, environment,
        sha256Hex, input.actor_label, input.upload_source);
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Bytes do comprovante pro GET de imagem do painel. */
export async function getMatrizTripReceiptImage(
  receiptId: string,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<{ bytes: Buffer; mime: string } | null> {
  const r = await dbPool.query<{ bytes: Buffer; mime: string }>(
    `SELECT b.bytes, m.mime
       FROM commerce.matriz_trip_receipt_blobs b
       JOIN commerce.matriz_trip_receipts m ON m.id = b.receipt_id
      WHERE b.receipt_id = $1 AND b.environment = $2`,
    [receiptId, environment],
  );
  return r.rows[0] ?? null;
}

// ─── Colaboradores da MATRIZ (0124 — fatia 1: CADASTRO; decisão do dono 07-04) ───
// A identidade reusa a porta única (network.partner_people: username único na
// rede + senha scrypt). O vínculo/papel do staff da matriz vive em
// network.matriz_collaborators — SEPARADO dos parceiros (zero grant, provado na
// 0124). Nesta fatia a pessoa criada NÃO loga em lugar nenhum: sem vínculo de
// loja, authenticatePersonGlobal devolve null (people.ts). As telas por função
// (rota do entregador / frente de caixa do vendedor) entram nas próximas fatias.

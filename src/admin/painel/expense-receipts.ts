import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';

export async function expenseReceiptsReady(db: Pool = defaultPool): Promise<boolean> {
  return Boolean((await db.query<{ ready: boolean }>(`SELECT to_regclass('commerce.matriz_expense_receipts') IS NOT NULL AS ready`)).rows[0]?.ready);
}
export async function getExpenseReceipt(id: string, environment = env.FAREJADOR_ENV, db: Pool = defaultPool) {
  const result = await db.query(`SELECT r.id,r.expense_id,r.created_at,r.reading_token IS NOT NULL
      AND r.reading_started_at>now()-interval '5 minutes' AS processing,
      a.id AS reading_id,a.status,a.amount::text,a.category,a.merchant,a.document_date::text,a.confidence,a.summary,
      e.description AS expense_description,e.amount::text AS expense_amount,e.payment_status,e.deleted_at IS NOT NULL AS expense_removed
    FROM commerce.matriz_expense_receipts r
    LEFT JOIN LATERAL (SELECT * FROM analytics.expense_receipt_readings
      WHERE environment=r.environment AND receipt_id=r.id ORDER BY created_at DESC,id DESC LIMIT 1) a ON true
    LEFT JOIN commerce.matriz_expenses e ON e.environment=r.environment AND e.id=r.expense_id
    WHERE r.environment=$1 AND r.id=$2`, [environment, id]);
  return result.rows[0] ?? null;
}
export async function addExpenseReceipt(bytes: Buffer, actor: string, environment = env.FAREJADOR_ENV, db: Pool = defaultPool) {
  const hash = createHash('sha256').update(bytes).digest();
  // A mesma foto já usada pela logística não pode virar uma segunda despesa avulsa.
  const trip = await db.query(`SELECT r.id FROM commerce.matriz_trip_receipt_blobs b
    JOIN commerce.matriz_trip_receipts r ON r.environment=b.environment AND r.id=b.receipt_id
    WHERE b.environment=$1 AND b.content_sha256=$2 LIMIT 1`, [environment, hash]);
  if (trip.rows.length) throw Error('receipt_belongs_to_trip');
  const client = await db.connect();
  let id: string | undefined;
  let duplicate = false;
  try {
    await client.query('BEGIN');
    const created = await client.query<{ id: string }>(`INSERT INTO commerce.matriz_expense_receipts
      (environment,content_sha256,mime,size_bytes,created_by) VALUES ($1,$2,'image/jpeg',$3,$4)
      ON CONFLICT (environment,content_sha256) DO NOTHING RETURNING id`, [environment, hash, bytes.length, actor]);
    id = created.rows[0]?.id;
    duplicate = !id;
    if (id) await client.query(`INSERT INTO commerce.matriz_expense_receipt_blobs(environment,receipt_id,bytes) VALUES ($1,$2,$3)`, [environment, id, bytes]);
    else id = (await client.query<{ id: string }>(`SELECT id FROM commerce.matriz_expense_receipts WHERE environment=$1 AND content_sha256=$2`, [environment, hash])).rows[0]!.id;
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
  return { receipt: await getExpenseReceipt(id!, environment, db), duplicate };
}
export async function getExpenseReceiptImage(id: string, linkedOnly: boolean, environment = env.FAREJADOR_ENV, db: Pool = defaultPool) {
  return (await db.query<{ bytes: Buffer; mime: string }>(`SELECT b.bytes,r.mime FROM commerce.matriz_expense_receipts r
    JOIN commerce.matriz_expense_receipt_blobs b ON b.environment=r.environment AND b.receipt_id=r.id
    WHERE r.environment=$1 AND r.id=$2 AND (NOT $3::boolean OR r.expense_id IS NOT NULL)`, [environment, id, linkedOnly])).rows[0] ?? null;
}
export async function receiptForExpense(id: string, environment = env.FAREJADOR_ENV, db: Pool = defaultPool) {
  if (!await expenseReceiptsReady(db)) return null;
  return (await db.query<{ id: string }>(`SELECT id FROM commerce.matriz_expense_receipts WHERE environment=$1 AND expense_id=$2`, [environment, id])).rows[0] ?? null;
}
export async function lockExpenseReceipt(client: PoolClient, environment: string, receiptId: string) {
  const row = (await client.query<{ expense_id: string | null; processing: boolean }>(`SELECT expense_id,
    reading_token IS NOT NULL AND reading_started_at>now()-interval '5 minutes' AS processing
    FROM commerce.matriz_expense_receipts WHERE environment=$1 AND id=$2 FOR UPDATE`, [environment, receiptId])).rows[0];
  if (!row) throw Error('expense_receipt_not_found');
  if (row.expense_id) throw Error('expense_receipt_already_linked');
  if (row.processing) throw Error('expense_receipt_processing');
}
export async function linkExpenseReceipt(client: PoolClient, environment: string, receiptId: string, expenseId: string) {
  await client.query(`UPDATE commerce.matriz_expense_receipts SET expense_id=$3,linked_at=now(),reading_token=NULL,reading_started_at=NULL
    WHERE environment=$1 AND id=$2`, [environment, receiptId, expenseId]);
}

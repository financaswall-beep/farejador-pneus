import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';

export interface ReceiptAttemptMetadata {
  model: string;
  extractor_version: string;
  prompt_version: string;
}

export type ReceiptAttemptResult =
  | {
      status: 'suggested';
      amount: number;
      category: string;
      merchant: string | null;
      document_date: string | null;
      confidence: number | null;
      summary: string;
    }
  | { status: 'unreadable'; summary: string }
  | { status: 'failed'; error_code: string; summary: string };

export async function beginReceiptAiAttempt(
  input: { receipt_id: string; environment?: 'prod' | 'test' } & ReceiptAttemptMetadata,
  dbPool: Pool = defaultPool,
): Promise<{ attempt_id: string; attempt_no: number }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const receipt = await client.query<{ workflow_status: string }>(`
      SELECT workflow_status FROM commerce.matriz_trip_receipts
       WHERE environment=$1 AND id=$2 FOR UPDATE
    `, [environment, input.receipt_id]);
    if (!receipt.rows[0]) throw new Error('receipt_not_found');
    if (receipt.rows[0].workflow_status === 'processing') throw new Error('receipt_processing');
    if (['linked', 'legacy_linked', 'rejected'].includes(receipt.rows[0].workflow_status)) {
      throw new Error('receipt_not_reviewable');
    }

    const next = await client.query<{ attempt_no: number }>(`
      SELECT COALESCE(max(attempt_no),0)::int + 1 AS attempt_no
        FROM commerce.matriz_trip_receipt_ai_attempts
       WHERE environment=$1 AND receipt_id=$2
    `, [environment, input.receipt_id]);
    const attemptNo = next.rows[0]!.attempt_no;
    const attempt = await client.query<{ id: string }>(`
      INSERT INTO commerce.matriz_trip_receipt_ai_attempts
        (environment,receipt_id,attempt_no,status,model,extractor_version,prompt_version)
      VALUES ($1,$2,$3,'processing',$4,$5,$6)
      RETURNING id
    `, [environment, input.receipt_id, attemptNo, input.model,
      input.extractor_version, input.prompt_version]);
    await client.query(`
      UPDATE commerce.matriz_trip_receipts
         SET workflow_status='processing',ai_status='pending'
       WHERE environment=$1 AND id=$2
    `, [environment, input.receipt_id]);
    await client.query('COMMIT');
    return { attempt_id: attempt.rows[0]!.id, attempt_no: attemptNo };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function completeReceiptAiAttempt(
  input: {
    attempt_id: string;
    result: ReceiptAttemptResult;
    environment?: 'prod' | 'test';
  },
  dbPool: Pool = defaultPool,
): Promise<{
    attempt_id: string;
    status: ReceiptAttemptResult['status'];
    workflow_status: 'review_required';
    ai_status: 'parsed' | 'unreadable' | 'pending';
  }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const pointer = await client.query<{ receipt_id: string }>(`
      SELECT receipt_id FROM commerce.matriz_trip_receipt_ai_attempts
       WHERE environment=$1 AND id=$2
    `, [environment, input.attempt_id]);
    if (!pointer.rows[0]) throw new Error('receipt_attempt_not_found');
    await client.query(`
      SELECT id FROM commerce.matriz_trip_receipts
       WHERE environment=$1 AND id=$2 FOR UPDATE
    `, [environment, pointer.rows[0].receipt_id]);
    const attempt = await client.query<{ status: ReceiptAttemptResult['status'] | 'processing' }>(`
      SELECT status FROM commerce.matriz_trip_receipt_ai_attempts
       WHERE environment=$1 AND id=$2 FOR UPDATE
    `, [environment, input.attempt_id]);
    if (attempt.rows[0]!.status !== 'processing') {
      const terminal = attempt.rows[0]!.status as ReceiptAttemptResult['status'];
      const aiStatus = terminal === 'suggested' ? 'parsed'
        : terminal === 'unreadable' ? 'unreadable' : 'pending';
      await client.query('COMMIT');
      return { attempt_id: input.attempt_id, status: terminal,
        workflow_status: 'review_required', ai_status: aiStatus };
    }

    const suggested = input.result.status === 'suggested' ? input.result : null;
    const errorCode = input.result.status === 'failed'
      ? input.result.error_code.trim().slice(0, 120) : null;
    await client.query(`
      UPDATE commerce.matriz_trip_receipt_ai_attempts
         SET status=$3,suggested_amount=$4,suggested_category=$5,
             suggested_merchant=$6,suggested_merchant_normalized=$7,
             suggested_document_date=$8::date,confidence=$9,summary=$10,
             error_code=$11,finished_at=now()
       WHERE environment=$1 AND id=$2 AND status='processing'
    `, [environment, input.attempt_id, input.result.status,
      suggested?.amount ?? null, suggested?.category ?? null,
      suggested?.merchant ?? null, suggested?.merchant?.trim().toLocaleLowerCase('pt-BR') ?? null,
      suggested?.document_date ?? null, suggested?.confidence ?? null,
      input.result.summary.slice(0, 500), errorCode]);

    const aiStatus = input.result.status === 'suggested' ? 'parsed'
      : input.result.status === 'unreadable' ? 'unreadable' : 'pending';
    await client.query(`
      UPDATE commerce.matriz_trip_receipts
         SET workflow_status = 'review_required',ai_status=$3,ai_summary=$4
       WHERE environment=$1 AND id=$2
    `, [environment, pointer.rows[0].receipt_id, aiStatus,
      input.result.summary.slice(0, 500)]);
    await client.query('COMMIT');
    return { attempt_id: input.attempt_id, status: input.result.status,
      workflow_status: 'review_required', ai_status: aiStatus };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

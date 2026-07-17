import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { insertMatrizExpenseInTransaction } from './queries-financeiro-integridade.js';
import { normalizeReceiptApproval, validateReceiptRejection,
  type ReceiptApprovalInput } from './receipt-review.js';
import { beginIntegrityOperation, completeIntegrityOperation, integrityResult,
  moneyCents, operationFingerprint, recordIntegrityEvent } from './stage5-integrity.js';
interface DecisionActor {
  actor_label: string;
  actor_admin_id?: string | null;
}
export interface ApproveReceiptInput extends ReceiptApprovalInput, DecisionActor {
  receipt_id: string;
  ai_attempt_id?: string | null;
  note?: string | null;
  legacy_expense_confirmed?: boolean;
  idempotency_key: string;
  environment?: 'prod' | 'test';
}
export interface RejectReceiptInput extends DecisionActor {
  receipt_id: string;
  ai_attempt_id?: string | null;
  reason: string;
  idempotency_key: string;
  environment?: 'prod' | 'test';
}
interface AttemptRow {
  id: string; attempt_no: number; status: string; suggested_amount: string | null;
  suggested_category: string | null; suggested_merchant: string | null;
  suggested_document_date: string | null; confidence: string | null; summary: string | null;
  model: string; extractor_version: string; prompt_version: string;
}
function todayInSaoPaulo(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}
function actorLabel(input: DecisionActor): string {
  const label = input.actor_label.trim().slice(0, 200);
  if (!label) throw new Error('receipt_actor_required');
  return label;
}

async function loadSelectedAttempt(
  client: PoolClient, environment: 'prod' | 'test', receiptId: string,
  selectedId?: string | null,
): Promise<AttemptRow | null> {
  const latest = await client.query<AttemptRow>(`
    SELECT id,attempt_no,status,suggested_amount::text,suggested_category,
           suggested_merchant,suggested_document_date::text,confidence::text,summary,
           model,extractor_version,prompt_version
      FROM commerce.matriz_trip_receipt_ai_attempts
     WHERE environment=$1 AND receipt_id=$2 AND status<>'processing'
     ORDER BY attempt_no DESC LIMIT 1
  `, [environment, receiptId]);
  if (!selectedId) return latest.rows[0] ?? null;
  const selected = await client.query<AttemptRow>(`
    SELECT id,attempt_no,status,suggested_amount::text,suggested_category,
           suggested_merchant,suggested_document_date::text,confidence::text,summary,
           model,extractor_version,prompt_version
      FROM commerce.matriz_trip_receipt_ai_attempts
     WHERE environment=$1 AND receipt_id=$2 AND id=$3 AND status<>'processing'
  `, [environment, receiptId, selectedId]);
  if (!selected.rows[0] || latest.rows[0]?.id !== selected.rows[0].id) {
    throw new Error('receipt_suggestion_stale');
  }
  return selected.rows[0];
}

function suggestionSnapshot(attempt: AttemptRow | null): Record<string, unknown> {
  if (!attempt) return {};
  return { ...attempt, suggested_amount: attempt.suggested_amount === null
    ? null : Number(attempt.suggested_amount),
    confidence: attempt.confidence === null ? null : Number(attempt.confidence) };
}

export async function approveMatrizTripReceipt(
  input: ApproveReceiptInput,
  dbPool: Pool = defaultPool,
): Promise<{ receipt_id: string; decision_id: string; expense_id: string;
    workflow_status: 'linked'; linked_existing: boolean }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const normalized = normalizeReceiptApproval(input, { today: todayInSaoPaulo(),
    max_amount: env.MATRIZ_RECEIPT_APPROVAL_MAX_AMOUNT });
  const label = actorLabel(input);
  const operation = { environment, domain: 'receipt.approve',
    idempotencyKey: input.idempotency_key, fingerprint: operationFingerprint({
      receipt_id: input.receipt_id, ai_attempt_id: input.ai_attempt_id ?? null,
      amount_cents: normalized.amount_cents, category: normalized.category,
      merchant: normalized.merchant, document_date: normalized.document_date,
      competence_month: normalized.competence_month,
      payment_status: normalized.payment_status,
      payment_date: normalized.payment_date ?? null, due_date: normalized.due_date ?? null,
      note: input.note?.trim() || null,
      retroactive_confirmed: !!input.retroactive_confirmed,
      competence_confirmed: !!input.competence_confirmed,
      possible_duplicate_confirmed: !!input.possible_duplicate_confirmed,
      legacy_expense_confirmed: !!input.legacy_expense_confirmed,
    }) };
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const started = await beginIntegrityOperation<Awaited<ReturnType<typeof approveMatrizTripReceipt>>>(client, operation);
    if (started.replayed) { await client.query('COMMIT'); return started.result; }
    const receipt = await client.query<{ trip_id: string; workflow_status: string }>(`
      SELECT trip_id,workflow_status FROM commerce.matriz_trip_receipts
       WHERE environment=$1 AND id=$2 FOR UPDATE
    `, [environment, input.receipt_id]);
    if (!receipt.rows[0]) throw new Error('receipt_not_found');
    if (receipt.rows[0].workflow_status !== 'review_required') throw new Error('receipt_not_reviewable');
    const trip = await client.query<{ trip_number: string; fuel_expense_id: string | null }>(`
      SELECT trip_number,fuel_expense_id FROM commerce.matriz_delivery_trips
       WHERE environment=$1 AND id=$2 FOR UPDATE
    `, [environment, receipt.rows[0].trip_id]);
    if (!trip.rows[0]) throw new Error('trip_not_found');
    const blob = await client.query<{ content_sha256: Buffer }>(`
      SELECT content_sha256 FROM commerce.matriz_trip_receipt_blobs
       WHERE environment=$1 AND receipt_id=$2
    `, [environment, input.receipt_id]);
    if (!blob.rows[0]) throw new Error('receipt_blob_not_found');
  const attempt = await loadSelectedAttempt(client, environment,
      input.receipt_id, input.ai_attempt_id);
    const snapshot = suggestionSnapshot(attempt);
    const activeCategory = await client.query(`SELECT 1 FROM commerce.matriz_expense_categories
      WHERE environment=$1 AND slug=$2 AND archived_at IS NULL`,
    [environment, normalized.category]);
    if (!activeCategory.rows[0]) throw new Error('category_invalid');
    const duplicateKey = `receipt-possible:${environment}:${normalized.category}:`
      + `${normalized.amount_cents}:${normalized.document_date}:${normalized.merchant ?? ''}`;
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [duplicateKey]);
    const possible = await client.query<{ receipt_id: string }>(`
      SELECT receipt_id FROM commerce.matriz_trip_receipt_decisions
       WHERE environment=$1 AND action='approve' AND receipt_id<>$2
         AND approved_category=$3 AND approved_amount=$4
         AND document_date=$5::date
         AND lower(COALESCE(approved_merchant,''))=lower(COALESCE($6,''))
       LIMIT 1
    `, [environment, input.receipt_id, normalized.category, normalized.amount,
      normalized.document_date, normalized.merchant]);
    if (possible.rows[0] && !input.possible_duplicate_confirmed) {
      throw new Error('receipt_possible_duplicate_confirmation_required');
    }
    let expenseId: string;
    let linkedExisting = false;
    if (trip.rows[0].fuel_expense_id) {
      const legacy = await client.query<{ id: string; category: string; amount: string;
        payment_status: string; deleted_at: string | null; document_date: string;
        competence_month: string; payment_date: string | null; due_date: string | null }>(`
        SELECT id,category,amount::text,payment_status,deleted_at,
          (occurred_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS document_date,
          ops.matriz_expense_competence_month(competence_month,occurred_at)::text AS competence_month,
          (paid_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS payment_date,
          due_date::text
          FROM commerce.matriz_expenses WHERE environment=$1 AND id=$2 FOR UPDATE
      `, [environment, trip.rows[0].fuel_expense_id]);
      if (legacy.rows[0] && !legacy.rows[0].deleted_at) {
        const equal = legacy.rows[0].category === normalized.category
          && moneyCents(Number(legacy.rows[0].amount)) === normalized.amount_cents
          && legacy.rows[0].payment_status === normalized.payment_status
          && legacy.rows[0].document_date === normalized.document_date
          && legacy.rows[0].competence_month === normalized.competence_month
          && (normalized.payment_status === 'paid'
            ? legacy.rows[0].payment_date === normalized.payment_date
            : legacy.rows[0].due_date === normalized.due_date);
        if (!input.legacy_expense_confirmed || !equal) {
          throw new Error(equal ? 'receipt_legacy_expense_confirmation_required'
            : 'receipt_legacy_expense_conflict');
        }
        expenseId = legacy.rows[0].id;
        linkedExisting = true;
      } else {
        expenseId = '';
      }
    } else {
      expenseId = '';
    }

    if (!expenseId) {
      const description = input.note?.trim()
        || `${trip.rows[0].trip_number} · comprovante aprovado${normalized.merchant ? ` · ${normalized.merchant}` : ''}`;
      const expense = await insertMatrizExpenseInTransaction(client, {
        environment, category: normalized.category, description,
        amount: normalized.amount, payment_status: normalized.payment_status,
        due_date: normalized.due_date, paid_at: normalized.payment_at,
        occurred_at: normalized.occurred_at, document_date: normalized.document_date,
        competence_month: normalized.competence_month,
        created_by: `comprovante:${label}`.slice(0, 200),
      });
      expenseId = expense.id;
      await recordIntegrityEvent(client, { environment, domain: 'matriz_expense',
        entityTable: 'commerce.matriz_expenses', entityId: expenseId,
        eventType: 'created_from_receipt_approval', actorLabel: label,
        idempotencyKey: operation.idempotencyKey,
        after: { ...expense, receipt_id: input.receipt_id } });
    }

    const differences = { amount_changed: attempt?.suggested_amount != null
      && moneyCents(Number(attempt.suggested_amount)) !== normalized.amount_cents,
      category_changed: attempt?.suggested_category != null
        && attempt.suggested_category !== normalized.category,
      merchant_changed: attempt?.suggested_merchant != null
        && attempt.suggested_merchant.trim() !== normalized.merchant,
      document_date_changed: attempt?.suggested_document_date != null
        && attempt.suggested_document_date !== normalized.document_date,
      amount_attention: normalized.amount_attention,
      possible_duplicate_receipt_id: possible.rows[0]?.receipt_id ?? null,
      linked_existing: linkedExisting };
    const decision = await client.query<{ id: string }>(`
      INSERT INTO commerce.matriz_trip_receipt_decisions
        (environment,receipt_id,attempt_id,action,content_sha256,actor_admin_id,
         actor_label,suggestion_snapshot,approved_amount,approved_category,
         approved_merchant,document_date,competence_month,payment_status,
         payment_date,due_date,differences,expense_id,idempotency_key,request_fingerprint)
      VALUES ($1,$2,$3,'approve',$4,$5,$6,$7::jsonb,$8,$9,$10,$11::date,$12::date,
              $13,$14::date,$15::date,$16::jsonb,$17,$18,$19)
      RETURNING id
    `, [environment, input.receipt_id, attempt?.id ?? null, blob.rows[0].content_sha256,
      input.actor_admin_id ?? null, label, JSON.stringify(snapshot), normalized.amount,
      normalized.category, normalized.merchant, normalized.document_date,
      normalized.competence_month, normalized.payment_status,
      normalized.payment_date ?? null, normalized.due_date ?? null,
      JSON.stringify(differences), expenseId, operation.idempotencyKey, operation.fingerprint]);
    await client.query(`UPDATE commerce.matriz_trip_receipts
      SET workflow_status='linked',ai_expense_id=$3
      WHERE environment=$1 AND id=$2`, [environment, input.receipt_id, expenseId]);
    const result = integrityResult({ receipt_id: input.receipt_id,
      decision_id: decision.rows[0]!.id, expense_id: expenseId,
      workflow_status: 'linked' as const, linked_existing: linkedExisting });
    await recordIntegrityEvent(client, { environment, domain: 'receipt',
      entityTable: 'commerce.matriz_trip_receipts', entityId: input.receipt_id,
      eventType: linkedExisting ? 'approved_linked_existing' : 'approved',
      actorLabel: label, idempotencyKey: operation.idempotencyKey,
      before: { workflow_status: 'review_required' }, after: result });
    await completeIntegrityOperation(client, operation,
      'commerce.matriz_trip_receipt_decisions', result.decision_id, result);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export async function rejectMatrizTripReceipt(
  input: RejectReceiptInput,
  dbPool: Pool = defaultPool,
): Promise<{ receipt_id: string; decision_id: string; workflow_status: 'rejected' }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const { reason } = validateReceiptRejection(input.reason);
  const label = actorLabel(input);
  const operation = { environment, domain: 'receipt.reject',
    idempotencyKey: input.idempotency_key,
    fingerprint: operationFingerprint({ receipt_id: input.receipt_id,
      ai_attempt_id: input.ai_attempt_id ?? null, reason }) };
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const started = await beginIntegrityOperation<Awaited<ReturnType<typeof rejectMatrizTripReceipt>>>(client, operation);
    if (started.replayed) { await client.query('COMMIT'); return started.result; }
    const receipt = await client.query<{ workflow_status: string }>(`
      SELECT workflow_status FROM commerce.matriz_trip_receipts
       WHERE environment=$1 AND id=$2 FOR UPDATE
    `, [environment, input.receipt_id]);
    if (!receipt.rows[0]) throw new Error('receipt_not_found');
    if (receipt.rows[0].workflow_status !== 'review_required') throw new Error('receipt_not_reviewable');
    const blob = await client.query<{ content_sha256: Buffer }>(`
      SELECT content_sha256 FROM commerce.matriz_trip_receipt_blobs
       WHERE environment=$1 AND receipt_id=$2
    `, [environment, input.receipt_id]);
    if (!blob.rows[0]) throw new Error('receipt_blob_not_found');
    const attempt = await loadSelectedAttempt(client, environment,
      input.receipt_id, input.ai_attempt_id);
    const decision = await client.query<{ id: string }>(`
      INSERT INTO commerce.matriz_trip_receipt_decisions
        (environment,receipt_id,attempt_id,action,content_sha256,actor_admin_id,
         actor_label,suggestion_snapshot,reason,idempotency_key,request_fingerprint)
      VALUES ($1,$2,$3,'reject',$4,$5,$6,$7::jsonb,$8,$9,$10) RETURNING id
    `, [environment, input.receipt_id, attempt?.id ?? null, blob.rows[0].content_sha256,
      input.actor_admin_id ?? null, label, JSON.stringify(suggestionSnapshot(attempt)),
      reason, operation.idempotencyKey, operation.fingerprint]);
    await client.query(`UPDATE commerce.matriz_trip_receipts
      SET workflow_status='rejected' WHERE environment=$1 AND id=$2`,
    [environment, input.receipt_id]);
    const result = integrityResult({ receipt_id: input.receipt_id,
      decision_id: decision.rows[0]!.id, workflow_status: 'rejected' as const });
    await recordIntegrityEvent(client, { environment, domain: 'receipt',
      entityTable: 'commerce.matriz_trip_receipts', entityId: input.receipt_id,
      eventType: 'rejected', actorLabel: label, idempotencyKey: operation.idempotencyKey,
      before: { workflow_status: 'review_required' }, after: { ...result, reason } });
    await completeIntegrityOperation(client, operation,
      'commerce.matriz_trip_receipt_decisions', result.decision_id, result);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

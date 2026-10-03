import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { businessDateSaoPaulo } from '../../shared/business-time.js';
import { normalizeReceiptApproval } from './receipt-review.js';
import { insertMatrizExpenseInTransaction } from './queries-financeiro-integridade.js';
import { beginIntegrityOperation, completeIntegrityOperation, operationFingerprint, recordIntegrityEvent } from './stage5-integrity.js';

export interface LostFuelReceiptInput {
  trip_id: string; amount: number; expected_amount: number | null;
  expense_date: string; payment_status: 'paid' | 'pending';
  payment_date?: string | null; due_date?: string | null; retroactive_confirmed?: boolean;
  reason: string; confirmed: boolean; idempotency_key: string;
  actor_label: string; actor_admin_id?: string | null; environment?: 'prod' | 'test';
}
export interface LostFuelReceiptResult {
  trip_id: string; approval_id: string; expense_id: string; financial_status: string;
}

export async function approveMatrizLostFuelReceipt(
  input: LostFuelReceiptInput, dbPool: Pool = defaultPool,
): Promise<LostFuelReceiptResult> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const reason = input.reason.trim(), actor = input.actor_label.trim();
  if (!input.confirmed || reason.length < 3 || reason.length > 500 || !actor || actor.length > 200) {
    throw Error('lost_receipt_confirmation_required');
  }
  const normalized = normalizeReceiptApproval({ ...input, category: 'combustivel',
    document_date: input.expense_date, competence_month: input.expense_date.slice(0, 7) + '-01',
  }, { today: businessDateSaoPaulo(new Date()), max_amount: env.MATRIZ_RECEIPT_APPROVAL_MAX_AMOUNT });
  const operation = { environment, domain: 'logistics.lost_fuel_receipt', idempotencyKey: input.idempotency_key,
    fingerprint: operationFingerprint({ trip_id: input.trip_id, amount_cents: normalized.amount_cents,
      expected_amount: input.expected_amount, expense_date: normalized.document_date, reason,
      payment_status: normalized.payment_status, payment_date: normalized.payment_date ?? null,
      due_date: normalized.due_date ?? null, retroactive_confirmed: !!input.retroactive_confirmed,
      actor, actor_admin_id: input.actor_admin_id ?? null }) };
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const started = await beginIntegrityOperation<LostFuelReceiptResult>(client, operation);
    if (started.replayed) { await client.query('COMMIT'); return started.result; }
    const trip = (await client.query<{ trip_number: string; fuel_spent: string | null; fuel_expense_id: string | null }>(`
      SELECT trip_number,fuel_spent::text,fuel_expense_id FROM commerce.matriz_delivery_trips
      WHERE environment=$1 AND id=$2 AND status='closed' AND deleted_at IS NULL FOR UPDATE
    `, [environment, input.trip_id])).rows[0];
    if (!trip) throw Error('trip_not_found');
    if ((trip.fuel_spent === null ? null : Number(trip.fuel_spent)) !== input.expected_amount) {
      throw Error('trip_fuel_annotation_changed');
    }
    // Nunca soma uma nova despesa por cima de combustível já registrado/aprovado.
    if (trip.fuel_expense_id) throw Error('trip_fuel_already_approved');
    const existing = await client.query(`SELECT 1 FROM commerce.matriz_trip_approved_expenses($2,$1) e
      WHERE e.category='combustivel' LIMIT 1`, [environment, input.trip_id]);
    if (existing.rows.length) throw Error('trip_fuel_already_approved');
    const pending = await client.query(`SELECT 1 FROM commerce.matriz_trip_receipts
      WHERE environment=$1 AND trip_id=$2 AND workflow_status IN ('uploaded','processing','review_required') LIMIT 1`,
    [environment, input.trip_id]);
    if (pending.rows.length) throw Error('trip_receipt_review_required');
    const expense = await insertMatrizExpenseInTransaction(client, {
      environment, category: 'combustivel', amount: normalized.amount,
      description: `${trip.trip_number} · Sem comprovante — aprovada pelo proprietário · ${reason}`,
      occurred_at: normalized.occurred_at, document_date: normalized.document_date,
      competence_month: normalized.competence_month, payment_status: normalized.payment_status,
      paid_at: normalized.payment_at, due_date: normalized.due_date, created_by: actor,
    });
    const approval = (await client.query<{ id: string }>(`INSERT INTO commerce.matriz_trip_lost_receipts
      (environment,trip_id,expense_id,approved_amount,expense_date,reason,actor_admin_id,actor_label,idempotency_key)
      VALUES ($1,$2,$3,$4,$5::date,$6,$7,$8,$9) RETURNING id`,
    [environment, input.trip_id, expense.id, normalized.amount, normalized.document_date, reason,
      input.actor_admin_id ?? null, actor, input.idempotency_key])).rows[0]!;
    await recordIntegrityEvent(client, { environment, domain: 'matriz_expense',
      entityTable: 'commerce.matriz_expenses', entityId: expense.id, eventType: 'created_without_receipt',
      actorLabel: actor, idempotencyKey: input.idempotency_key,
      after: { ...expense, trip_id: input.trip_id, approval_id: approval.id } });
    await recordIntegrityEvent(client, { environment, domain: 'matriz_logistics',
      entityTable: 'commerce.matriz_delivery_trips', entityId: input.trip_id, eventType: 'lost_fuel_receipt_approved',
      actorLabel: actor, idempotencyKey: input.idempotency_key,
      before: { fuel_spent: input.expected_amount },
      after: { expense_id: expense.id, approval_id: approval.id, amount: normalized.amount,
        expense_date: normalized.document_date, payment_status: normalized.payment_status, reason,
        actor_admin_id: input.actor_admin_id ?? null } });
    const status = (await client.query<{ status: string }>(
      'SELECT commerce.matriz_trip_financial_status($2,$1) status', [environment, input.trip_id])).rows[0]!;
    const result = { trip_id: input.trip_id, approval_id: approval.id, expense_id: expense.id, financial_status: status.status };
    await completeIntegrityOperation(client, operation, 'commerce.matriz_trip_lost_receipts', approval.id, result);
    await client.query('COMMIT'); return result;
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

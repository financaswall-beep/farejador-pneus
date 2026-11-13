import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { lockSettlementObligation } from './matriz-ledger-settlement-payment.js';
import { syncPartnerInstallmentDueDate } from './partner-installment-due-date.js';
import { beginIntegrityOperation, completeIntegrityOperation, operationFingerprint,
  recordIntegrityEvent } from './stage5-integrity.js';

export const installmentDateParams = z.object({
  order_id: z.string().uuid(), number: z.coerce.number().int().min(1).max(120),
});
export const installmentDateBody = z.object({
  expected_due_date: z.string().date(), due_date: z.string().date(), idempotency_key: z.string().uuid(),
}).strict();
type Command = z.infer<typeof installmentDateParams> & z.infer<typeof installmentDateBody>;
type Result = { order_id: string; number: number; due_date: string; next_due: string };

export async function readOpenInstallment(client: PoolClient, order_id: string, number: number, due_date: string) {
  const environment = env.FAREJADOR_ENV;
  if (!env.WHOLESALE_FINANCE || !env.MATRIZ_CENTRAL_LEDGER || !env.MATRIZ_CENTRAL_LEDGER_READ)
    throw new Error('sale_plan_finance_required');
  const order = await client.query<{ status: string; payment_status: string; buyer_name: string }>(
    `SELECT o.status,o.payment_status,c.name buyer_name FROM commerce.wholesale_orders o
       JOIN commerce.wholesale_customers c ON c.environment=o.environment AND c.id=o.buyer_id
      WHERE o.environment=$1 AND o.id=$2 FOR UPDATE OF o`, [environment, order_id]);
  if (!order.rowCount) throw new Error('sale_not_found');
  if (order.rows[0]!.status !== 'confirmed' || order.rows[0]!.payment_status !== 'pending')
    throw new Error('sale_installment_changed');
  const revenue = await client.query<{ id: string; sold_on: string }>(
    `SELECT id,competence_on::text sold_on FROM finance.matriz_ledger_transactions
      WHERE environment=$1 AND source_id=$2 AND metadata ? 'sale_plan'
        AND source_type IN ('commerce.wholesale_order.revenue','commerce.wholesale_order.arrival_revenue')`,
    [environment, order_id]);
  if (revenue.rowCount !== 1) throw new Error('sale_installment_changed');
  if (due_date < revenue.rows[0]!.sold_on) throw new Error('installment_before_sale');
  const obligation = await lockSettlementObligation(client, environment, revenue.rows[0]!.id);
  const open = obligation.sale_plan?.installments.filter(part => part.balance > 0) ?? [];
  const current = open.find(part => part.number === number);
  if (!current) throw new Error('sale_installment_changed');
  return { current, open, obligation, buyerName: order.rows[0]!.buyer_name };
}

export async function changeInstallmentInTransaction(client: PoolClient, command: Command, actor: string, expectedBalance?: number) {
  const environment = env.FAREJADOR_ENV;
  const { order_id, number, due_date, expected_due_date } = command;
  const operation = { environment, domain: 'wholesale_sale.installment_due_date',
    idempotencyKey: command.idempotency_key, fingerprint: operationFingerprint({ order_id, number, due_date, expected_due_date }) };
  const replay = await beginIntegrityOperation<Result>(client, operation);
  if (replay.replayed) return replay.result;
  const { current, open, obligation } = await readOpenInstallment(client, order_id, number, due_date);
  if (current.due_date !== expected_due_date || (expectedBalance !== undefined && current.balance !== expectedBalance))
    throw new Error('sale_installment_changed');
  const nextDue = open.map(part => part.number === number ? due_date : part.due_date).sort()[0]!;
  const result = { order_id, number, due_date, next_due: nextDue };
  if (due_date !== expected_due_date) {
    await client.query(`UPDATE commerce.wholesale_orders
       SET installment_due_dates=installment_due_dates || jsonb_build_object($3::text,$4::text),due_date=$5::date
       WHERE environment=$1 AND id=$2`, [environment, order_id, number, due_date, nextDue]);
    if (obligation.source_type === 'commerce.wholesale_order.arrival_revenue') {
      await client.query("SELECT set_config('app.matrix_partner_bridge','on',true)");
      await syncPartnerInstallmentDueDate(client, environment, obligation.id, order_id);
    }
    await recordIntegrityEvent(client, { environment, domain: 'wholesale_sale', entityTable: 'commerce.wholesale_orders',
      entityId: order_id, actorLabel: actor, eventType: 'installment_due_date_changed', idempotencyKey: operation.idempotencyKey,
      before: { number, due_date: expected_due_date }, after: { number, due_date } });
  }
  await completeIntegrityOperation(client, operation, 'commerce.wholesale_orders', order_id, result);
  return result;
}

export async function changeSaleInstallmentDueDate(command: Command, actor: string, db: Pool = pool): Promise<Result> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await changeInstallmentInTransaction(client, command, actor);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    if ((error as {code?: string}).code === '42703' && (error as Error).message.includes('installment_due_dates'))
      throw new Error('installment_date_migration_required');
    throw error;
  } finally { client.release(); }
}

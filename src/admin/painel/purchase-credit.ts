import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { env } from '../../shared/config/env.js';
import { moneyCents, type MatrizEnvironment } from './stage5-integrity.js';
import { lockAdvance, lockPurchase, postApplication, syncPurchaseStatus } from './supplier-advance-ledger.js';
import { purchaseSchedule } from './purchase-installment-balances.js';

export function purchaseCreditEnabled() {
  return env.WHOLESALE_FINANCE && env.MATRIZ_CENTRAL_LEDGER && env.MATRIZ_CENTRAL_LEDGER_READ;
}

/** A compra ou baixa controla a transação e a chave de idempotência de todos os abatimentos. */
export async function applyPurchaseCredit(db: PoolClient, environment: MatrizEnvironment,
  purchaseId: string, obligationId: string, installment: number | undefined,
  amount: number, at: string, actor: string) {
  if (!purchaseCreditEnabled()) throw Error('purchase_credit_disabled');
  const supplier = (await db.query<{supplier_id: string}>(
    'SELECT supplier_id FROM commerce.wholesale_purchases WHERE environment=$1 AND id=$2 FOR UPDATE',
    [environment, purchaseId])).rows[0];
  if (!supplier || await lockPurchase(db, environment, purchaseId, supplier.supplier_id, at) !== obligationId)
    throw Error('settlement_target_invalid');
  const schedule = await purchaseSchedule(db, environment, purchaseId);
  const part = schedule.find(row => row.installment_number === installment);
  if ((schedule.length || installment !== undefined) && !part) throw Error('purchase_installment_required');
  const open = Number((await db.query('SELECT finance.matriz_ledger_obligation_balance($1,$2) balance',
    [environment, obligationId])).rows[0].balance);
  let needed = moneyCents(amount);
  if (needed <= 0 || needed > moneyCents(Math.min(open, Number(part?.balance ?? open))))
    throw Error('settlement_exceeds_balance');
  // A ordem é estável entre compras concorrentes. Releia cada saldo depois de travar sua origem.
  const credits = await db.query<{advance_id: string}>(`SELECT advance_id FROM finance.supplier_advance_movements
    WHERE environment=$1 AND supplier_id=$2 GROUP BY advance_id HAVING sum(delta)>0
    AND min(competence_on) <= ($3::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date
    ORDER BY min(competence_on),advance_id`, [environment,supplier.supplier_id,at]);
  const ids: string[] = [];
  for (const {advance_id} of credits.rows) {
    const balance = await lockAdvance(db, environment, advance_id, supplier.supplier_id, at);
    const take = Math.min(needed, moneyCents(balance.available));
    if (take <= 0) continue;
    ids.push(await postApplication(db, {environment, at, actor, reason:'Crédito usado na compra', key:randomUUID()},
      take / 100, obligationId, {supplier_id:supplier.supplier_id, purchase_id:purchaseId, advance_id,
        purchase_installment:installment, installment_due:part?.due_date, installment_amount:part?.amount,
        installment_balance_before:part ? (moneyCents(Number(part.balance)) - (moneyCents(amount)-needed))/100 : undefined}));
    needed -= take;
    if (!needed) break;
  }
  if (needed) throw Error('purchase_credit_unavailable');
  const remaining = await syncPurchaseStatus(db, environment, purchaseId, obligationId, at);
  return {ids, remaining, installmentRemaining: part ? (moneyCents(Number(part.balance))-moneyCents(amount))/100 : undefined};
}

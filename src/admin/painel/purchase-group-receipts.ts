import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';

/** Só enriquece a apresentação. A foto e a despesa continuam nos registros originais. */
export async function purchaseGroupReceipts(expenseIds: string[], environment = env.FAREJADOR_ENV, db = pool) {
  if (!expenseIds.length) return [];
  return (await db.query<{ expense_id: string; receipt_id: string }>(
    `SELECT expense_id,id receipt_id FROM commerce.matriz_expense_receipts
      WHERE environment=$1 AND expense_id=ANY($2::uuid[])`, [environment, expenseIds])).rows;
}

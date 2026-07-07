// Auditoria da aba Compras (2026-07-06): fatia do banco da MATRIZ — cancelar compra (0127)
// + arquivar fornecedor. Espelho do cancelamento da venda (0116, queries-atacado-cancelar.ts):
// a compra registrada errada era invisível e irreversível; agora sai sem apagar.
// Porta de entrada continua sendo ./queries.js (barrel) — importadores não mudam.
import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';

export interface CancelWholesalePurchaseInput {
  purchase_id: string;
  cancelled_by: string;
  reason?: string | null;
  environment?: 'prod' | 'test';
}

/** CANCELA uma compra de atacado (confirmed → cancelled, sem apagar). Transacional:
 *  trava a compra (FOR UPDATE), grava a trilha (0127) e TIRA do galpão o que a compra
 *  tinha colocado, revertendo o custo MÉDIO pelo inverso ponderado —
 *  novo = (qty*custo − qty_item*custo_item)/(qty − qty_item).
 *  A reversão é INCONDICIONAL (a entrada da compra também é — simetria exata; a venda
 *  usa flag porque a baixa dela usa). Clamps honestos, mesma família do 0116:
 *  já vendeu parte → quantidade clampa em 0 e não fica negativa; média mudou no meio
 *  (vendas/entradas) → custo clampa em 0; quantidade zerou → mantém o último custo.
 *  Corrigir a assimetria de verdade exige livro-razão (Fase B, adiada de propósito).
 *  Ranking/preço por medida/a pagar se corrigem SOZINHOS (tudo filtra status='confirmed').
 *  Cancelar 2x → purchase_already_cancelled (a trilha original não é sobrescrita). */
export async function cancelWholesalePurchase(
  input: CancelWholesalePurchaseInput,
  dbPool: Pool = defaultPool,
): Promise<{ purchase_id: string; cancelled_at: string; payment_status: string }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const client: PoolClient = await dbPool.connect();
  try {
    await client.query('BEGIN');

    const cur = await client.query<{ status: string; payment_status: string }>(
      `SELECT status, payment_status FROM commerce.wholesale_purchases
        WHERE id = $1 AND environment = $2 LIMIT 1 FOR UPDATE`,
      [input.purchase_id, environment],
    );
    if (!cur.rows[0]) throw new Error('purchase_not_found');
    if (cur.rows[0].status !== 'confirmed') throw new Error('purchase_already_cancelled');

    const upd = await client.query<{ cancelled_at: string }>(
      `UPDATE commerce.wholesale_purchases
          SET status = 'cancelled', cancelled_at = now(), cancelled_by = $3, cancel_reason = $4
        WHERE id = $1 AND environment = $2
        RETURNING cancelled_at`,
      [input.purchase_id, environment, input.cancelled_by, input.reason?.slice(0, 300) ?? null],
    );

    // Reverte o galpão item a item (a medida gravada no item é a CANÔNICA do galpão).
    // Linha a linha em sequência: cada UPDATE lê o estado que a linha anterior deixou.
    const items = await client.query<{ measure: string; quantity: number; unit_cost: string }>(
      `SELECT measure, quantity, unit_cost FROM commerce.wholesale_purchase_items
        WHERE environment = $1 AND purchase_id = $2`,
      [environment, input.purchase_id],
    );
    for (const it of items.rows) {
      await client.query(
        `UPDATE commerce.wholesale_stock
            SET unit_cost = CASE
                  WHEN quantity_on_hand - $3 > 0 THEN
                    round(GREATEST(quantity_on_hand * unit_cost - $3 * $4, 0)
                          / (quantity_on_hand - $3), 2)
                  ELSE unit_cost
                END,
                quantity_on_hand = GREATEST(0, quantity_on_hand - $3)
          WHERE environment = $1 AND measure = $2`,
        [environment, it.measure, it.quantity, Number(it.unit_cost)],
      );
    }

    await client.query('COMMIT');
    return {
      purchase_id: input.purchase_id,
      cancelled_at: upd.rows[0]!.cancelled_at,
      payment_status: cur.rows[0].payment_status,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** ARQUIVA um fornecedor (soft delete — deleted_at, nunca DELETE). Some do formulário,
 *  do ranking e do preço por medida (todos filtram deleted_at IS NULL); as compras
 *  dele CONTINUAM no histórico (JOIN por id) e dívida pendente CONTINUA no a pagar
 *  (getWholesaleFinance não filtra deleted — dívida não some com o fornecedor).
 *  Arquivar 2x → supplier_not_found. */
export async function archiveWholesaleSupplier(
  supplierId: string,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<{ id: string }> {
  const r = await dbPool.query<{ id: string }>(
    `UPDATE commerce.wholesale_suppliers
        SET deleted_at = now()
      WHERE id = $1 AND environment = $2 AND deleted_at IS NULL
      RETURNING id`,
    [supplierId, environment],
  );
  if (!r.rows[0]) throw new Error('supplier_not_found');
  return r.rows[0];
}

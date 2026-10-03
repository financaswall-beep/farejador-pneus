import type { PoolClient } from 'pg';
import { env } from '../../shared/config/env.js';
import type { TireCondition } from '../../shared/tire-condition.js';
import { matrizLedgerActor, matrizLedgerAmount, postMatrizLedgerTransaction } from './matriz-ledger-posting.js';
import { ensureWholesaleSaleRevenue, ensureWholesaleSaleCogs, type WholesaleSaleLedgerState } from './matriz-ledger-wholesale-sales.js';
import { cancelMatrizSaleRevenue } from './matriz-ledger-sale-cancel.js';

async function reverseTransaction(
  client: PoolClient,
  sale: WholesaleSaleLedgerState,
  originalId: string,
  sourceType: string,
  cancelledAt: string,
  cancelledBy: string,
  description: string,
  reason: string,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `SELECT finance.reverse_matriz_ledger_transaction(
       $1::env_t,$2,$3,$4,
       ($5::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date,
       $6,$7,NULL,$8::jsonb
     ) id`,
    [
      sale.environment, originalId, sourceType, sale.orderId, cancelledAt,
      description, matrizLedgerActor(cancelledBy),
      JSON.stringify({ order_id: sale.orderId, reason }),
    ],
  );
  return result.rows[0]!.id;
}

async function returnedCogs(
  client: PoolClient,
  sale: WholesaleSaleLedgerState,
  returned: Array<{
    measure: string; brand: string; tire_condition: TireCondition; quantity: number;
  }>,
): Promise<number> {
  const result = await client.query<{ amount: string }>(
    `WITH returned AS (
       SELECT measure,brand,tire_condition,quantity
         FROM jsonb_to_recordset($3::jsonb)
           AS x(measure text,brand text,tire_condition text,quantity int)
     ), sold AS (
       SELECT measure,brand,tire_condition,sum(quantity)::numeric quantity,
              sum(quantity*unit_cost)::numeric cost
         FROM commerce.wholesale_order_items
        WHERE environment=$1 AND order_id=$2 GROUP BY measure,brand,tire_condition
     )
     SELECT COALESCE(sum(
       LEAST(returned.quantity,sold.quantity)*sold.cost/NULLIF(sold.quantity,0)
     ),0)::numeric(14,2)::text amount
       FROM returned JOIN sold USING (measure,brand,tire_condition)`,
    [sale.environment, sale.orderId, JSON.stringify(returned)],
  );
  return matrizLedgerAmount(result.rows[0]!.amount, 'sale_ledger_cogs_invalid');
}

export async function postWholesaleSaleCancellation(
  client: PoolClient,
  sale: WholesaleSaleLedgerState,
  returned: Array<{
    measure: string; brand: string; tire_condition: TireCondition; quantity: number;
  }>,
  cancelledAt: string,
  cancelledBy: string,
  reason: string,
  verifiedReturnedCogs?: number,
): Promise<void> {
  if (!env.MATRIZ_CENTRAL_LEDGER) return;
  const revenueId = await ensureWholesaleSaleRevenue(client, sale);
  if (revenueId) await cancelMatrizSaleRevenue(client, {
    environment: sale.environment, orderId: sale.orderId, revenueId,
    sourceType: 'commerce.wholesale_order.revenue_cancel',
    cancelledAt, actor: cancelledBy, reason,
  });

  const originalCogs = await ensureWholesaleSaleCogs(client, sale);
  if (!originalCogs) return;
  const recovered = verifiedReturnedCogs ?? await returnedCogs(client, sale, returned);
  if (recovered === 0) return;
  const fullCogs = matrizLedgerAmount(sale.cogsAmount, 'sale_ledger_cogs_invalid');
  if (recovered === fullCogs) {
    await reverseTransaction(client, sale, originalCogs,
      'commerce.wholesale_order.cogs_cancel', cancelledAt, cancelledBy,
      'Retorno integral do custo ao estoque', reason);
    return;
  }
  await postMatrizLedgerTransaction(client, {
    environment: sale.environment,
    sourceType: 'commerce.wholesale_order.cogs_cancel', sourceId: sale.orderId,
    kind: 'inventory_recovery', amount: recovered, occurredAt: cancelledAt,
    description: 'Retorno parcial do custo ao estoque',
    createdBy: matrizLedgerActor(cancelledBy),
    lines: [
      { account_code: 'inventory', account_class: 'asset', side: 'debit', amount: recovered },
      { account_code: 'cost_of_goods_sold', account_class: 'expense', side: 'credit', amount: recovered },
    ],
    metadata: {
      order_id: sale.orderId, buyer_id: sale.buyerId, reason,
      returned_stock: returned, original_cogs_transaction_id: originalCogs,
    },
  });
}

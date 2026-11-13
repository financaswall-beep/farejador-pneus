import type { PoolClient } from 'pg';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { env } from '../../shared/config/env.js';
import { orderSalePlanSql } from '../painel/sale-payment-plan.js';
import type { LotSaleInput } from '../painel/lot-sale-schema.js';
import { moneyCents } from '../painel/stage5-integrity.js';

/** A segunda tentativa com os mesmos lotes enxerga a venda já confirmada. */
export async function checkExistingLotSale(db: PoolClient, sale: LotSaleInput, distinctFrom: string[]) {
  const lotIds = sale.allocations.map(row => row.lot_id.toLowerCase()).sort();
  const environment = env.FAREJADOR_ENV;
  await db.query(`SELECT id FROM commerce.tire_lots WHERE environment=$1 AND id=ANY($2::uuid[])
    ORDER BY id FOR UPDATE`, [environment,lotIds]);
  const result = await db.query(`
    SELECT o.id order_id,${orderSalePlanSql} acordo,o.payment_status,o.due_date
    FROM commerce.wholesale_orders o
    JOIN commerce.wholesale_customers c ON c.environment=o.environment AND c.id=o.buyer_id
    WHERE o.environment=$1 AND o.is_lot_sale AND o.status='confirmed'
      AND (o.sold_at AT TIME ZONE 'America/Sao_Paulo')::date=$2::date
      AND o.total_amount=$3::numeric
      AND (c.id=$4::uuid OR c.partner_id=$5::uuid OR lower(btrim(c.name))=lower($6))
      AND EXISTS (SELECT 1 FROM commerce.wholesale_order_items i WHERE i.environment=o.environment
        AND i.order_id=o.id AND i.tire_lot_id=$7::uuid)
      AND (SELECT jsonb_object_agg(i.tire_lot_id::text,i.quantity)
        FROM commerce.wholesale_order_items i WHERE i.environment=o.environment AND i.order_id=o.id)=$8::jsonb
      AND NOT (o.id=ANY($9::uuid[])) ORDER BY o.id LIMIT 20`,
    [environment,sale.sold_on,(moneyCents(sale.amount)-moneyCents(sale.discount))/100,
      sale.customer_id??null,sale.partner_id??null,sale.new_customer?.name.trim()??null,lotIds[0],
      JSON.stringify(Object.fromEntries(sale.allocations.map(row=>[row.lot_id.toLowerCase(),row.quantity]))),distinctFrom]);
  if (result.rows.length) {
    throw new McpError(ErrorCode.InvalidParams,
      'Venda compatível já cadastrada. Consulte o acordo. Para uma venda distinta identificada pelo dono, informe os IDs em vendas_distintas_de.',
      {vendas:result.rows});
  }
}

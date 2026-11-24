import {retailReceivedSql} from '../painel/retail-received-sql.js';
import type {PoolClient} from 'pg';
import { env } from '../../shared/config/env.js';
import { pool } from '../../persistence/db.js';
import { assertCurrentCatalogPrices } from '../../shared/catalog-pricing.js';
import { prepareMatrizWalkinStock } from '../painel/matriz-walkin-stock.js';
import { registerWalkinOrderSchema } from '../painel/route-schemas-orders.js';
import { assertRetailSaleMoney } from '../painel/sales-money.js';
import { moneyCents } from '../painel/stage5-integrity.js';
import {resolveSaleCustomer} from '../painel/sale-customers.js';
import { registerWalkinOrder } from '../painel/walkin-order.js';
import { assertHistorical, type Sale } from './retail-delivery-schemas.js';

export function requireRetailLedger() {
  if (!env.MATRIZ_CENTRAL_LEDGER) throw Error('financeiro_matriz_desabilitado');
}
function walkinInput(data:Sale) {
  return registerWalkinOrderSchema.parse({
    customer_mode:data.customer_mode, customer_ref:data.customer_ref, customer_name:data.customer_name,
    customer_phone:data.customer_phone, items:data.items, fulfillment_mode:data.delivered_at?'delivery':'pickup',
    delivery_address:data.delivery_address, source_tag:'walkin_balcao', idempotency_key:'milly-varejo-'+data.idempotency_key,
    payment_method:data.payments.length===1?data.payments[0]!.payment_method:'misto',
  });
}
export async function salePreview(db:PoolClient,data:Sale) {
  requireRetailLedger();
  assertHistorical(data.sold_at);
  if (data.delivered_at) {
    assertHistorical(data.delivered_at);
    if (Date.parse(data.delivered_at)<Date.parse(data.sold_at)) throw Error('entrega_anterior_a_venda');
  } else if (data.delivery_address) throw Error('informe_horario_da_entrega');
  const input=walkinInput(data);
  if (data.customer_mode==='existing' && !data.customer_ref) throw Error('sale_customer_required');
  if (data.customer_mode!=='existing' && data.customer_ref) throw Error('sale_customer_mode_invalid');
  if (data.customer_mode==='new' && !data.customer_name?.trim()) throw Error('sale_customer_name_required');
  if (data.customer_mode==='anonymous' && (data.customer_name || data.customer_phone)) throw Error('sale_customer_mode_invalid');
  const customer=data.customer_mode==='existing' ? await resolveSaleCustomer(db,env.FAREJADOR_ENV,input) : null;
  const products=assertRetailSaleMoney(data.items);
  const total=products+moneyCents(data.freight);
  if (total!==data.payments.reduce((sum,p)=>sum+moneyCents(p.amount),0)) throw Error('recebimentos_diferem_do_total');
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[[env.FAREJADOR_ENV,new Date(data.sold_at).toISOString(),total].join('|')]);
  const candidates=await db.query(`SELECT o.id FROM commerce.orders o JOIN core.units u ON u.id=o.unit_id AND u.environment=o.environment AND u.slug='main'
    WHERE o.environment=$1 AND o.partner_order_id IS NULL AND o.status<>'cancelled' AND o.created_at=$2::timestamptz
      AND o.total_amount=$3 AND NOT(o.id=ANY($4::uuid[])) LIMIT 1`,
    [env.FAREJADOR_ENV,data.sold_at,total/100,data.vendas_distintas_de??[]]);
  if (candidates.rowCount) throw Error('venda_parecida_localize_o_pedido_antes_de_lancar');
  await assertCurrentCatalogPrices(db,env.FAREJADOR_ENV,input.items.map(i=>({product_id:i.product_id,unit_price:i.reference_unit_price??i.unit_price})));
  const stock=await prepareMatrizWalkinStock(db,env.FAREJADOR_ENV,input.items.map(i=>({productId:i.product_id,quantity:i.quantity})));
  const cost=input.items.reduce((sum,i)=>sum+i.quantity*moneyCents(stock.costByProduct.get(i.product_id)!),0);
  const productRows=await db.query('SELECT id,product_name FROM commerce.products WHERE environment=$1 AND id=ANY($2::uuid[])',
    [env.FAREJADOR_ENV,input.items.map(i=>i.product_id)]);
  const names=new Map(productRows.rows.map(row=>[row.id,row.product_name]));
  return {cliente:customer?.name??data.customer_name??null,itens:input.items.map(i=>({...i,nome:names.get(i.product_id)})),produtos:products/100,frete:data.freight,entrada:total/100,recebimentos:data.payments,baixa:stock.lines,
    custo_dos_produtos:cost/100,entregue_em:data.delivered_at??null,despachos:0,mensagens:0};
}
export async function saveSale(db:PoolClient,data:Sale,actor:string) {
  const result=await registerWalkinOrder({...walkinInput(data),actor_label:actor},pool,db,
    {soldAt:data.sold_at,deliveredAt:data.delivered_at,freight:data.freight,payments:data.payments});
  const state=await retailOrder(db,result.order_id);
  if (!state.pago || !state.baixa_registrada) throw Error('venda_inconsistente');
  return state;
}

export async function retailOrder(db:Pick<PoolClient,'query'>,id:string,lock=false) {
  const row=(await db.query(`SELECT o.id AS order_id,o.order_number AS numero_pedido,o.status,o.delivery_status,
    o.delivered_at,o.created_at,o.fulfillment_mode,o.trip_id,o.total_amount::float8 AS total,
    items.produtos,items.custo,items.itens_sem_custo,items.quantidade,
    COALESCE(receipts.total,0)::float8 AS recebido,COALESCE(receipts.total=o.total_amount,false) AS pago,
    EXISTS(SELECT 1 FROM commerce.matriz_stock_origins pending
      WHERE pending.environment=o.environment AND pending.reference_id=o.id AND pending.source='varejo'
        AND pending.status='pending') AS origem_a_conferir,
    EXISTS(SELECT 1 FROM audit.events a WHERE a.environment=o.environment AND a.entity_id=o.id
      AND a.event_type='matriz_galpao_decrement') AS baixa_registrada
    FROM commerce.orders o JOIN core.units u ON u.id=o.unit_id AND u.environment=o.environment AND u.slug='main'
    CROSS JOIN LATERAL (SELECT sum(i.unit_price*i.quantity-i.discount_amount)::float8 produtos,
      sum(i.matriz_unit_cost*i.quantity)::float8 custo,count(*) FILTER(WHERE i.matriz_unit_cost IS NULL)::int itens_sem_custo,
      sum(i.quantity)::int quantidade FROM commerce.order_items i WHERE i.order_id=o.id AND i.environment=o.environment) items
    LEFT JOIN LATERAL (${retailReceivedSql}) receipts ON true
    WHERE o.environment=$1 AND o.id=$2 AND o.partner_order_id IS NULL`+(lock?' FOR UPDATE OF o':''),[env.FAREJADOR_ENV,id])).rows[0];
  if (!row) throw Error('venda_matriz_nao_encontrada');
  return {...row,created_at:new Date(row.created_at).toISOString(),delivered_at:row.delivered_at?new Date(row.delivered_at).toISOString():null};
}

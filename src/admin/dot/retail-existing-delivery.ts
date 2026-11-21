import {z} from 'zod';
import type {PoolClient} from 'pg';
import {env} from '../../shared/config/env.js';
import {consumeMatrizGalpaoReservation} from '../../atendente-v2/matriz-stock-reservation.js';
import {postMatrizRetailSaleFacts} from '../painel/matriz-ledger-retail-sales.js';
import {moneyCents} from '../painel/stage5-integrity.js';
import {assertHistorical,id,saleSchema} from './retail-delivery-schemas.js';
import {requireRetailLedger,retailOrder} from './retail-sale.js';
import {registerInventoryWrite} from './inventory-registry.js';

const schema=z.object({idempotency_key:id,order_id:id,delivered_at:z.string().datetime({offset:true}),
  delivery_address:z.string().trim().min(2).max(500),payments:saleSchema.shape.payments.optional()}).strict();
async function preview(db:PoolClient,data:z.infer<typeof schema>) {
  requireRetailLedger();
  assertHistorical(data.delivered_at);
  const row=await retailOrder(db,data.order_id,true);
  const delivered=Date.parse(data.delivered_at);
  if(row.trip_id || row.status==='cancelled' || row.delivery_status==='failed' || delivered<Date.parse(row.created_at)
    || (row.delivered_at && Date.parse(row.delivered_at)!==delivered)) throw Error('situacao_do_pedido_incompativel');
  if (!row.quantidade || row.itens_sem_custo) throw Error('verifique_custo_do_pedido');
  if(row.pago && data.payments) throw Error('venda_ja_paga_vincule_sem_novo_pagamento');
  if(!row.pago) {
    if(row.recebido || !data.payments || data.payments.reduce((s,p)=>s+moneyCents(p.amount),0)!==moneyCents(row.total))
      throw Error('confira_o_recebimento_existente');
    const posted=await db.query(`SELECT 1 FROM finance.matriz_ledger_transactions WHERE environment=$1 AND source_id=$2
      AND source_type LIKE 'commerce.order.%' AND source_type<>'commerce.order.cogs' LIMIT 1`,[env.FAREJADOR_ENV,data.order_id]);
    if(posted.rowCount) throw Error('use_a_baixa_da_obrigacao_existente');
  }
  if(!row.baixa_registrada) {
    const reserved=await db.query(`SELECT 1 FROM audit.events a WHERE a.environment=$1 AND a.entity_id=$2 AND a.event_type='matriz_galpao_reserved'
      AND NOT EXISTS(SELECT 1 FROM audit.events r WHERE r.environment=a.environment AND r.entity_id=a.entity_id AND r.event_type='matriz_galpao_reservation_released') LIMIT 1`,
      [env.FAREJADOR_ENV,data.order_id]);
    if(!reserved.rowCount) throw Error('pedido_sem_reserva_ou_baixa_confira_o_estoque');
  }
  return {numero_pedido:row.numero_pedido,total:row.total,produtos:row.produtos,frete:(moneyCents(row.total)-moneyCents(row.produtos))/100,
    custo:row.custo,entrada_nova:row.pago?0:row.total,baixa_unidades:row.baixa_registrada?0:row.quantidade,entregue_em:data.delivered_at,
    rota_nova:false,despachos:0,mensagens:0};
}
registerInventoryWrite('retail','registrar_entrega_de_venda_matriz','Registra a entrega já feita de um pedido existente da Matriz sem abrir rota. Se já pago, omita payments. Informe recebimentos somente quando ainda não registrados. Confira baixa, pagamento e número do pedido.',
  schema,async(db,data,actor)=>{
    const planned=await preview(db,data);
    const payments=data.payments;
    const method=payments ? payments.length===1?payments[0]!.payment_method:'misto' : null;
    await db.query(`UPDATE commerce.orders SET fulfillment_mode='delivery',delivery_status='delivered',status='delivered',
      delivery_address=$3,delivered_at=$4,closed_at=COALESCE(closed_at,$4),closed_by=COALESCE(closed_by,$5),
      payment_method=COALESCE($6,payment_method),updated_at=now() WHERE environment=$1 AND id=$2`,
      [env.FAREJADOR_ENV,data.order_id,data.delivery_address,data.delivered_at,actor,method]);
    if (planned.baixa_unidades) await consumeMatrizGalpaoReservation(db,env.FAREJADOR_ENV,data.order_id);
    await postMatrizRetailSaleFacts(db,env.FAREJADOR_ENV,data.order_id,payments,data.delivered_at);
    const result=await retailOrder(db,data.order_id);
    if(!result.baixa_registrada || !result.pago) throw Error('venda_inconsistente');
    return result;
  },false,preview);

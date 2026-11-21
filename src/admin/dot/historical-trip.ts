import type {PoolClient} from 'pg';
import {env} from '../../shared/config/env.js';
import {tripSelect} from '../painel/queries-logistica-trip-select.js';
import {moneyCents} from '../painel/stage5-integrity.js';
import {assertHistorical,type Trip} from './retail-delivery-schemas.js';
import {retailOrder,requireRetailLedger} from './retail-sale.js';
import {applyTripExpenses,tripExpense} from './historical-trip-expenses.js';

export interface PlannedDelivery {
  id:string; numero_pedido:null; status:string; trip_id:null; delivery_status:string; created_at:string;
  delivered_at:string; baixa_registrada:boolean; pago:boolean; quantidade:number; itens_sem_custo:number;
  total:number; produtos:number; custo:number;
}
export async function previewTrip(db:PoolClient,data:Trip,planned?:PlannedDelivery) {
  if (!env.MATRIZ_LOGISTICS) throw Error('logistica_matriz_desabilitada');
  if (data.expenses.length && !env.MATRIZ_EXPENSES) throw Error('expenses_disabled');
  requireRetailLedger();
  assertHistorical(data.ended_at);
  const start=Date.parse(data.started_at),end=Date.parse(data.ended_at);
  if (end<start) throw Error('fim_anterior_a_saida');
  if (new Set(data.deliveries.map(item=>item.order_id)).size!==data.deliveries.length) throw Error('pedido_repetido_na_rota');
  const deliveries=[];
  for (const item of [...data.deliveries].sort((a,b)=>a.order_id.localeCompare(b.order_id))) {
    const order=planned?.id===item.order_id ? {...planned,order_id:planned.id} : await retailOrder(db,item.order_id,true);
    const delivered=Date.parse(item.delivered_at);
    if (delivered<start || delivered>end || delivered<new Date(order.created_at).getTime()) throw Error('horario_entrega_incompativel');
    if (order.trip_id) throw Error('pedido_ja_vinculado_a_rota');
    if (!['paid','delivered','confirmed'].includes(order.status) || ['failed','dispatched'].includes(order.delivery_status))
      throw Error('situacao_do_pedido_incompativel');
    if (!order.baixa_registrada || !order.quantidade || order.itens_sem_custo) throw Error('verifique_baixa_e_custo_do_pedido');
    if (order.delivery_status!=='delivered' && !order.pago) throw Error('confira_recebimento_do_pedido');
    if (order.delivered_at && delivered!==new Date(order.delivered_at).getTime()) throw Error('entrega_com_outro_horario');
    deliveries.push({pedido:order.numero_pedido,id:order.order_id,produtos:order.produtos,frete:(moneyCents(order.total)-moneyCents(order.produtos))/100,
      custo:order.custo,total:order.total,entregue_em:item.delivered_at,entrega_ja_registrada:order.delivery_status==='delivered'});
  }
  const expenses=[];
  const seen=new Set<string>();
  for (const item of data.expenses) {
    const key='expense_id' in item ? item.expense_id : JSON.stringify([item.category,item.amount,item.occurred_at,item.description]);
    if (seen.has(key)) throw Error('despesa_repetida_na_rota');
    seen.add(key);
    expenses.push(await tripExpense(db,item));
  }
  const spent=expenses.reduce((s,x)=>s+moneyCents(x.amount),0);
  const revenue=deliveries.reduce((s,x)=>s+moneyCents(x.total)-moneyCents(x.custo),0);
  return {pedidos:deliveries,despesas:expenses,total_despesas:spent/100,
    saida_nova:expenses.filter(e=>e.acao==='lancar').reduce((s,e)=>s+moneyCents(e.amount),0)/100,
    sobra_antes_das_despesas_gerais:(revenue-spent)/100,baixa_adicional:0,nova_entrada:0,despachos:0,mensagens:0};
}
export async function tripResult(db:Pick<PoolClient,'query'>,id:string) {
  const row=(await db.query(tripSelect+' AND t.id=$2',[env.FAREJADOR_ENV,id])).rows[0];
  if (!row) throw Error('rota_matriz_nao_encontrada');
  const summary=row.resumo;
  const expenses=Number(row.despesas_total);
  return {rota_id:id,numero_rota:row.trip_number,status:row.status,inicio:new Date(row.started_at).toISOString(),fim:row.ended_at?new Date(row.ended_at).toISOString():null,
    entregas:summary.entregues,produtos:summary.faturamento_pneus,frete:summary.frete_total,
    custo_pneus:summary.itens_sem_custo?null:summary.custo_pneus,gastos:expenses,despesas:row.despesas,
    sobra_antes_das_despesas_gerais:summary.itens_sem_custo?null:(moneyCents(summary.faturamento_total)-moneyCents(summary.custo_pneus)-moneyCents(expenses))/100};
}
export async function saveTrip(db:PoolClient,data:Trip,actor:string) {
  const preview=await previewTrip(db,data);
  const fuel=preview.despesas.filter(e=>e.category==='combustivel').reduce((s,e)=>s+moneyCents(e.amount),0)/100;
  const trip=(await db.query(`INSERT INTO commerce.matriz_delivery_trips
    (environment,courier_name,status,started_at,ended_at,notes,created_by,fuel_spent,recorded_after_delivery)
    VALUES ($1,$2,'closed',$3,$4,$5,$6,$7,true) RETURNING id`,
  [env.FAREJADOR_ENV,data.courier_name,data.started_at,data.ended_at,data.destination,actor,fuel])).rows[0];
  for (const delivery of data.deliveries) {
    await db.query(`UPDATE commerce.orders SET trip_id=$3,fulfillment_mode='delivery',delivery_status='delivered',
      status='delivered',delivery_courier=$4,delivered_at=$5,closed_at=COALESCE(closed_at,$5),updated_at=now(),
      delivery_address=COALESCE(delivery_address,$6)
      WHERE environment=$1 AND id=$2 AND trip_id IS NULL`,[env.FAREJADOR_ENV,delivery.order_id,trip.id,data.courier_name,delivery.delivered_at,data.destination]);
  }
  await applyTripExpenses(db,data.expenses,trip.id,actor);
  const result=await tripResult(db,trip.id);
  if (result.sobra_antes_das_despesas_gerais!==preview.sobra_antes_das_despesas_gerais || result.entregas!==data.deliveries.length)
    throw Error('resultado_da_rota_inconsistente');
  return result;
}

import {retailReceivedSql} from '../painel/retail-received-sql.js';
import {z} from 'zod';
import {pool} from '../../persistence/db.js';
import {env} from '../../shared/config/env.js';
import {registerConnectionRead,registerInventoryRead as read,registerInventoryWrite as write} from './inventory-registry.js';
import {transact,lockGrant} from './installment-reviews.js';
import {tripResult} from './historical-trip.js';
import {id} from './retail-delivery-schemas.js';
import type {PoolClient} from 'pg';
import {moneyCents} from '../painel/stage5-integrity.js';

registerConnectionRead('retomar_propostas_varejo_matriz','Recupere propostas ainda válidas desta conexão, inclusive a chave original. Confira o estado e os efeitos antes de pedir autorização ou repetir uma operação.',
  z.object({}).strict(),async(_data,identity)=>transact(async db=>{
    const grant=await lockGrant(db,identity.person_id,identity.grant_id);
    return {propostas:(await db.query(`SELECT r.id AS proposta,r.operation_key AS idempotency_key,r.tool_name AS ferramenta,
      r.expires_at,r.decision AS decisao FROM network.dot_operation_reviews r
      WHERE r.environment=$1 AND r.grant_id=$2 AND r.executed_at IS NULL AND r.expires_at>clock_timestamp()
      AND r.decision IS DISTINCT FROM 'recusada'
      AND ((r.permission_domain='retail' AND $3) OR (r.permission_domain='route' AND $4))
      AND (r.tool_name<>'registrar_venda_e_rota_matriz' OR $3)
      ORDER BY r.expires_at DESC LIMIT 30`,[env.FAREJADOR_ENV,identity.grant_id,!!grant.retail_operations_enabled,!!grant.route_operations_enabled])).rows};
  }));
read('conferir_balcao_do_dia_matriz','Conferência das vendas de balcão da Matriz por data de venda em Brasília. Mostra pedidos com divergência de recebimento, de custo ou de baixa.',
  z.object({dia:z.string().date()}).strict(),async data=>{
    if(!env.MATRIZ_CENTRAL_LEDGER_READ) throw Error('central_ledger_disabled');
    const rows=(await pool.query(`SELECT o.id,o.order_number AS numero,o.total_amount::float8 AS vendido,COALESCE(caixa.total,0)::float8 AS recebido,
      EXISTS(SELECT 1 FROM audit.events a WHERE a.environment=o.environment AND a.entity_id=o.id AND a.event_type='matriz_galpao_decrement') AS baixa,
      EXISTS(SELECT 1 FROM commerce.order_items i WHERE i.environment=o.environment AND i.order_id=o.id AND i.matriz_unit_cost IS NULL) AS custo_pendente,
      o.trip_id FROM commerce.orders o JOIN core.units u ON u.environment=o.environment AND u.id=o.unit_id AND u.slug='main'
      LEFT JOIN LATERAL (${retailReceivedSql}) caixa ON true
      WHERE o.environment=$1 AND o.partner_order_id IS NULL AND o.source='walkin_balcao' AND o.status<>'cancelled'
      AND o.created_at>=($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
      AND o.created_at<(($2::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo') ORDER BY o.created_at,o.id LIMIT 1001`,
      [env.FAREJADOR_ENV,data.dia])).rows;
    if (rows.length>1000) throw Error('mais_de_mil_vendas_no_dia_use_relatorio_do_painel');
    return {dia:data.dia,pedidos:rows.length,vendido:rows.reduce((s,r)=>s+moneyCents(r.vendido),0)/100,
      recebido:rows.reduce((s,r)=>s+moneyCents(r.recebido),0)/100,
      para_conferir:rows.filter(r=>r.vendido!==r.recebido||!r.baixa||r.custo_pendente)};
  });
const correction=z.object({idempotency_key:id,expense_id:id,rota_origem:id,rota_destino:id,motivo:z.string().trim().min(4).max(300)}).strict();
async function expenseMove(db:PoolClient,data:z.infer<typeof correction>) {
  if(!env.MATRIZ_LOGISTICS) throw Error('logistica_matriz_desabilitada');
  if(data.rota_origem===data.rota_destino) throw Error('mesma_rota');
  const trips=await db.query(`SELECT id FROM commerce.matriz_delivery_trips WHERE environment=$1 AND id=ANY($2::uuid[])
    AND recorded_after_delivery AND status='closed' AND deleted_at IS NULL ORDER BY id FOR UPDATE`,[env.FAREJADOR_ENV,[data.rota_origem,data.rota_destino]]);
  if (trips.rowCount!==2) throw Error('correcao_exige_duas_rotas_historicas');
  const row=(await db.query(`SELECT e.amount::float8 valor,e.category categoria,e.description descricao FROM commerce.matriz_expenses e
    WHERE e.environment=$1 AND e.id=$2 AND e.delivery_trip_id=$3 AND e.deleted_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM commerce.matriz_trip_receipts r WHERE r.environment=e.environment AND r.ai_expense_id=e.id)
    AND NOT EXISTS(SELECT 1 FROM commerce.matriz_trip_lost_receipts r WHERE r.environment=e.environment AND r.expense_id=e.id)
    FOR UPDATE OF e`,[env.FAREJADOR_ENV,data.expense_id,data.rota_origem])).rows[0];
  if(!row) throw Error('vinculo_de_despesa_divergente');
  return {...row,saida_nova:0,variacao_gastos_origem:-row.valor,variacao_gastos_destino:row.valor};
}
write('route','corrigir_rota_de_despesa_matriz','Move a despesa entre duas rotas históricas informadas, com motivo e histórico da autorização. Preserva o pagamento original.',
  correction,async(db,data)=>{
    const expense=await expenseMove(db,data);
    await db.query('UPDATE commerce.matriz_expenses SET delivery_trip_id=$3 WHERE environment=$1 AND id=$2',[env.FAREJADOR_ENV,data.expense_id,data.rota_destino]);
    if(expense.categoria==='combustivel') await db.query(`UPDATE commerce.matriz_delivery_trips t SET fuel_spent=(
      SELECT COALESCE(sum(e.amount),0) FROM commerce.matriz_trip_approved_expenses(t.id,t.environment) e WHERE e.category='combustivel')
      WHERE t.environment=$1 AND t.id=ANY($2::uuid[])`,[env.FAREJADOR_ENV,[data.rota_origem,data.rota_destino]]);
    return {origem:await tripResult(db,data.rota_origem),destino:await tripResult(db,data.rota_destino)};
  },false,expenseMove);

import { readPage, rejectFilters, type DotReadContext } from './read-model.js';
import { paymentMethodSql } from './safe-values.js';
import { env } from '../../shared/config/env.js';
import type { PoolClient } from 'pg';
import type { Environment } from '../../shared/types/chatwoot.js';

// Publish only cities from the official catalogue. A same-turn route decision takes
// precedence over a recent mention in the conversation; neither confirms a stop.
async function negotiationMunicipality(db:Pick<PoolClient,'query'>,environment:Environment,requestId:string) {
  const result=await db.query<{municipality_key:string;municipio:string;fonte:string}>(`WITH pedido AS (
    SELECT q.conversation_id,q.created_at,m.sent_at FROM ops.milly_consultas q
    JOIN core.messages m ON m.environment=q.environment AND m.id=q.trigger_message_id AND m.conversation_id=q.conversation_id
    WHERE q.environment=$1 AND q.id=$2
  ), roteada AS (
    SELECT c.municipality_key,c.display_name municipio,'roteamento_entrega_deste_turno' fonte
    FROM pedido p JOIN ops.partner_routing_decisions r ON r.environment=$1 AND r.conversation_id=p.conversation_id
      AND r.modality='delivery' AND r.decision_kind='matrix' AND r.decided_at BETWEEN p.sent_at AND p.created_at
    JOIN network.municipality_catalog c ON c.active AND lower(btrim(r.municipio)) IN (c.municipality_key,lower(c.display_name))
  )
  SELECT * FROM roteada UNION ALL
  SELECT c.municipality_key,c.display_name,'referencia_recente_da_conversa'
    FROM pedido p JOIN analytics.v_bot_demand_location l ON l.environment=$1 AND l.conversation_id=p.conversation_id
      AND l.observed_at BETWEEN p.created_at-interval '24 hours' AND p.created_at
    JOIN network.municipality_catalog c ON c.active AND lower(btrim(l.municipio)) IN (c.municipality_key,lower(c.display_name))
    WHERE NOT EXISTS (SELECT FROM roteada) LIMIT 1`,[environment,requestId]);
  return result.rows[0];
}

/** Aggregate route workload and observed expenses without stops' addresses or driver identifiers. */
export async function readNegotiationRoutes(db:Pick<PoolClient,'query'>,environment:Environment,requestId:string) {
  const city=await negotiationMunicipality(db,environment,requestId);
  const row=await db.query(`WITH abertas AS (
    SELECT count(DISTINCT t.id)::int rotas_abertas, count(o.id)::int entregas_pendentes,
      count(o.id) FILTER (WHERE o.delivery_status='pending')::int aguardando_saida,
      count(o.id) FILTER (WHERE o.delivery_status='dispatched')::int em_entrega,
      count(o.id) FILTER (WHERE c.municipality_key IS NULL)::int entregas_sem_municipio_cadastrado,
      CASE WHEN $2::text IS NOT NULL THEN count(o.id) FILTER (WHERE c.municipality_key=$2)::int END
        entregas_com_municipio_cadastrado_igual,
      CASE WHEN $2::text IS NOT NULL THEN count(DISTINCT t.id) FILTER (WHERE c.municipality_key=$2)::int END
        rotas_com_municipio_cadastrado_igual
    FROM commerce.matriz_delivery_trips t LEFT JOIN commerce.orders o
      ON o.environment=t.environment AND o.trip_id=t.id AND o.status<>'cancelled'
      AND o.delivery_status IN ('pending','dispatched') AND o.fulfillment_mode='delivery' AND o.partner_order_id IS NULL
    LEFT JOIN commerce.geo_resolutions g ON g.environment=o.environment AND g.id=o.geo_resolution_id
    LEFT JOIN network.municipality_catalog c ON c.active AND c.state_code=g.state_code
      AND lower(btrim(g.city_name)) IN (c.municipality_key,lower(c.display_name))
    WHERE t.environment=$1 AND t.status='open' AND t.deleted_at IS NULL
  ), encerradas AS (
    SELECT t.fuel_spent, (
      SELECT sum(e.amount) FROM commerce.matriz_trip_approved_expenses(t.id,t.environment) e
    ) despesas_aprovadas FROM commerce.matriz_delivery_trips t
    WHERE t.environment=$1 AND t.deleted_at IS NULL AND t.status='closed'
      AND t.ended_at>=(((now() AT TIME ZONE 'America/Sao_Paulo')::date-29)::timestamp AT TIME ZONE 'America/Sao_Paulo')
      AND t.ended_at<=now()
  ), historico AS (
    SELECT count(*) rotas_encerradas, count(despesas_aprovadas) rotas_com_despesa_aprovada,
      round(sum(despesas_aprovadas)*100) total_despesas_aprovadas_centavos,
      round(avg(despesas_aprovadas)*100) media_despesas_aprovadas_por_rota_com_registro_centavos,
      count(*) FILTER (WHERE fuel_spent>0) rotas_com_combustivel_informado,
      round((sum(fuel_spent) FILTER (WHERE fuel_spent>0))*100) total_combustivel_informado_centavos,
      round((avg(fuel_spent) FILTER (WHERE fuel_spent>0))*100) media_combustivel_por_rota_com_registro_centavos
    FROM encerradas
  ) SELECT to_jsonb(abertas) || jsonb_build_object('historico_30_dias',to_jsonb(historico)) AS dados
    FROM abertas CROSS JOIN historico`,[environment,city?.municipality_key??null]);
  return {...row.rows[0]!.dados as Record<string,unknown>,
    praca_referencia:city?{municipio:city.municipio,fonte:city.fonte}:null,
    leitura_praca:'A praça é referência municipal. Os contadores comparam somente o município cadastrado em entregas pendentes de rotas abertas. Coincidência municipal não confirma endereço, encaixe na rota, horário ou custo adicional.',
    leitura:'Médias por rota encerrada com registro nos últimos 30 dias. Combustível informado pode constar entre as despesas aprovadas. Valores são separados e não representam o custo de incluir uma parada.'};
}

export function readDotTrips(ctx:DotReadContext) {
  rejectFilters(ctx,'medida');
  return readPage(ctx,`SELECT t.id,t.trip_number,t.courier_collaborator_id,t.status,t.km_start,t.km_end,
    t.km_end-t.km_start distance_km,t.fuel_spent,t.started_at,t.ended_at,
    commerce.matriz_trip_financial_status(t.id,t.environment) financial_status,
    (SELECT count(*)::int FROM commerce.orders o WHERE o.environment=t.environment AND o.trip_id=t.id
      AND o.status<>'cancelled' AND o.delivery_status IN ('pending','dispatched')) remaining_count,
    (SELECT count(*)::int FROM commerce.orders o WHERE o.environment=t.environment AND o.trip_id=t.id
      AND o.status<>'cancelled' AND o.delivery_status='delivered') delivered_count,
    (SELECT count(*)::int FROM commerce.orders o WHERE o.environment=t.environment AND o.trip_id=t.id
      AND o.delivery_status='failed') failed_count,
    (SELECT sum(o.total_amount)::text FROM commerce.orders o WHERE o.environment=t.environment AND o.trip_id=t.id
      AND o.status<>'cancelled' AND o.delivery_status='delivered') delivered_revenue_brl,
    (SELECT COALESCE(sum(e.amount),0)::text FROM commerce.matriz_trip_approved_expenses(t.id,t.environment) e) approved_expenses_brl,
    (SELECT count(*)::int FROM commerce.matriz_trip_receipts r WHERE r.environment=t.environment AND r.trip_id=t.id
      AND r.workflow_status IN ('uploaded','processing','review_required')) pending_receipts
    FROM commerce.matriz_delivery_trips t WHERE t.environment=$1 AND t.deleted_at IS NULL
      AND (t.started_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2::date AND $3::date
      AND ($4::uuid IS NULL OR t.id=$4) AND $5=''`,'started_at DESC,id DESC',
  'Receita das entregas e despesas aprovadas são componentes distintos. Combustível informado pode aguardar conferência; não some duas vezes. Entregadores por código.');
}

export function readDotPickups(ctx:DotReadContext) {
  rejectFilters(ctx,'medida');
  return readPage(ctx,`SELECT o.id,o.order_number,o.created_at,o.status,o.total_amount,${paymentMethodSql('o.payment_method')} payment_method,
    o.pickup_ready_at,o.pickup_arrived_at,o.pickup_installation_started_at,o.retrieved_at,
    commerce.pickup_reservation_deadline(o,NULL::commerce.partner_orders,$8::int) reservation_expires_at,
    CASE WHEN o.retrieved_at IS NOT NULL THEN 'retirado' WHEN o.pickup_installation_started_at IS NOT NULL THEN 'instalando'
      WHEN o.pickup_arrived_at IS NOT NULL THEN 'cliente_chegou'
      WHEN o.pickup_ready_at IS NOT NULL THEN 'pronto_para_retirar' ELSE 'aguardando' END stage,
    EXISTS(SELECT 1 FROM audit.events a WHERE a.environment=o.environment AND a.entity_id=o.id
      AND a.event_type='matriz_galpao_reserved') reserved
    FROM commerce.orders o JOIN core.units u ON u.environment=o.environment AND u.id=o.unit_id AND u.slug='main'
    WHERE o.environment=$1 AND o.partner_order_id IS NULL AND o.fulfillment_mode='pickup' AND o.status<>'cancelled'
      AND (o.status='open' OR (o.retrieved_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2::date AND $3::date)
      AND (o.status<>'open' OR EXISTS(SELECT 1 FROM audit.events a WHERE a.environment=o.environment AND a.entity_id=o.id
        AND a.event_type='matriz_galpao_reserved')) AND ($4::uuid IS NULL OR o.id=$4) AND $5=''`,
  'created_at DESC,id DESC','Inclui todas as reservas abertas atuais e retiradas concluídas no período.',
  [env.BOT_PICKUP_RESERVATION_HOURS]);
}

export function readDotExpenses(ctx:DotReadContext,view:'despesas'|'comprovantes'|'categorias') {
  rejectFilters(ctx,'medida');
  if(view==='categorias')rejectFilters(ctx,'referencia');
  if(view==='comprovantes')return readPage(ctx,`SELECT r.id,r.trip_id,r.created_at,r.ai_status,r.workflow_status,
    r.ai_expense_id expense_id,'rota' source FROM commerce.matriz_trip_receipts r WHERE r.environment=$1
      AND (r.created_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2::date AND $3::date
      AND ($4::uuid IS NULL OR r.trip_id=$4) AND $5=''
    UNION ALL SELECT r.id,NULL::uuid,r.created_at,NULL::text,
      CASE WHEN r.expense_id IS NULL THEN 'pending' ELSE 'linked' END,r.expense_id,'avulso'
    FROM commerce.matriz_expense_receipts r WHERE r.environment=$1
      AND (r.created_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2::date AND $3::date
      AND ($4::uuid IS NULL OR r.expense_id=$4) AND $5=''`,'created_at DESC,id DESC',
  'Metadados de comprovantes; fotos, links, leitura do documento e dados fiscais ficam privados.');
  if(view==='categorias')return readPage(ctx,`SELECT category AS id,category,count(*)::int count,sum(amount)::text amount_brl,
    sum(amount) FILTER(WHERE payment_status='pending')::text pending_brl,
    sum(amount) FILTER(WHERE payment_status='paid')::text paid_brl FROM commerce.matriz_expenses
    WHERE environment=$1 AND deleted_at IS NULL AND category<>'funcionario'
      AND (occurred_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2::date AND $3::date
      AND $4::uuid IS NULL AND $5='' GROUP BY category`,'amount_brl::numeric DESC,id');
  return readPage(ctx,`SELECT e.id,e.category,e.amount,e.occurred_at,e.payment_status,e.due_date,e.paid_at,
    EXISTS(SELECT 1 FROM commerce.matriz_expense_receipts r WHERE r.environment=e.environment AND r.expense_id=e.id)
      OR EXISTS(SELECT 1 FROM commerce.matriz_trip_receipts r WHERE r.environment=e.environment AND r.ai_expense_id=e.id
        AND r.workflow_status='approved') has_receipt
    FROM commerce.matriz_expenses e WHERE e.environment=$1 AND e.deleted_at IS NULL AND e.category<>'funcionario'
      AND (e.occurred_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2::date AND $3::date
      AND ($4::uuid IS NULL OR e.id=$4) AND $5=''`,'occurred_at DESC,id DESC',
  'Despesas operacionais registradas; descrições, beneficiários e pagamentos individuais da equipe omitidos. Para totais consolidados use o financeiro.');
}

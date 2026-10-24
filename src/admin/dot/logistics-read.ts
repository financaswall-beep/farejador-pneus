import { readPage, rejectFilters, type DotReadContext } from './read-model.js';
import { paymentMethodSql } from './safe-values.js';

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
    o.pickup_arrived_at,o.pickup_installation_started_at,o.retrieved_at,
    CASE WHEN o.retrieved_at IS NOT NULL THEN 'retirado' WHEN o.pickup_installation_started_at IS NOT NULL THEN 'instalando'
      WHEN o.pickup_arrived_at IS NOT NULL THEN 'cliente_chegou' ELSE 'aguardando' END stage,
    EXISTS(SELECT 1 FROM audit.events a WHERE a.environment=o.environment AND a.entity_id=o.id
      AND a.event_type='matriz_galpao_reserved') reserved
    FROM commerce.orders o JOIN core.units u ON u.environment=o.environment AND u.id=o.unit_id AND u.slug='main'
    WHERE o.environment=$1 AND o.partner_order_id IS NULL AND o.fulfillment_mode='pickup' AND o.status<>'cancelled'
      AND (o.status='open' OR (o.retrieved_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2::date AND $3::date)
      AND (o.status<>'open' OR EXISTS(SELECT 1 FROM audit.events a WHERE a.environment=o.environment AND a.entity_id=o.id
        AND a.event_type='matriz_galpao_reserved')) AND ($4::uuid IS NULL OR o.id=$4) AND $5=''`,
  'created_at DESC,id DESC','Inclui todas as reservas abertas atuais e retiradas concluídas no período.');
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

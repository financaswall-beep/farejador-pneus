import { readPage, type DotReadContext } from './read-model.js';
import { paymentMethodSql } from './safe-values.js';

export function readDotRetail(ctx:DotReadContext) {
  return readPage(ctx,`SELECT o.id,o.order_number,o.created_at,o.status,o.fulfillment_mode,o.source,
    o.delivery_status,o.retrieved_at,o.delivered_at,${paymentMethodSql('o.payment_method')} payment_method,o.total_amount,
    (SELECT count(*)::int FROM commerce.order_items i WHERE i.environment=o.environment AND i.order_id=o.id) items_count,
    COALESCE((SELECT jsonb_agg(x ORDER BY x.id) FROM (SELECT i.id,p.product_code,p.brand,s.tire_size,
      i.quantity,i.unit_price,i.discount_amount,i.matriz_unit_cost
      FROM commerce.order_items i LEFT JOIN commerce.products p ON p.environment=i.environment AND p.id=i.product_id
      LEFT JOIN commerce.tire_specs s ON s.environment=p.environment AND s.product_id=p.id
      WHERE i.environment=o.environment AND i.order_id=o.id ORDER BY i.id LIMIT 50) x),'[]') items
    FROM commerce.orders o JOIN core.units u ON u.environment=o.environment AND u.id=o.unit_id AND u.slug='main'
    WHERE o.environment=$1 AND o.partner_order_id IS NULL
      AND (o.created_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2::date AND $3::date
      AND ($4::uuid IS NULL OR o.id=$4) AND ($5='' OR EXISTS (SELECT 1 FROM commerce.order_items i
        JOIN commerce.tire_specs s ON s.environment=i.environment AND s.product_id=i.product_id
        WHERE i.environment=o.environment AND i.order_id=o.id AND s.tire_size ILIKE '%'||$5||'%'))`,
  'created_at DESC,id DESC','Histórico por criação do pedido. Pedido aberto ou cancelado não é venda realizada. Até 50 itens por pedido; items_count informa o total.');
}

export function readDotWholesale(ctx:DotReadContext,view:'vendas'|'compradores'|'medidas'|'inativos') {
  if(view==='inativos')return readPage(ctx,`SELECT o.buyer_id AS id,count(*)::int lifetime_purchases,
    max(o.sold_at) last_purchase_at,
    ($3::date-(max(o.sold_at) AT TIME ZONE 'America/Sao_Paulo')::date)::int days_without_purchase
    FROM commerce.wholesale_orders o WHERE o.environment=$1 AND o.status='confirmed'
      AND (o.partner_transfer_status IS NULL OR o.partner_transfer_status IN ('settled','received'))
      AND (o.sold_at AT TIME ZONE 'America/Sao_Paulo')::date<=$3::date
      AND ($4::uuid IS NULL OR o.buyer_id=$4) AND ($5='' OR EXISTS(SELECT 1 FROM commerce.wholesale_order_items i
        WHERE i.environment=o.environment AND i.order_id=o.id AND i.measure ILIKE '%'||$5||'%'))
    GROUP BY o.buyer_id HAVING max(o.sold_at)<(($3::date-30)::timestamp AT TIME ZONE 'America/Sao_Paulo')`,
  'days_without_purchase DESC,id','Compradores que já compraram e não compram há mais de 30 dias na data final do período. Histórico registrado, sem contatos pessoais.');
  if(view==='compradores')return readPage(ctx,`SELECT o.buyer_id AS id,count(*)::int purchases,
    sum(COALESCE(o.settled_total_amount,o.total_amount))::text revenue_brl,max(o.sold_at) last_purchase_at,
    ((now() AT TIME ZONE 'America/Sao_Paulo')::date-(max(o.sold_at) AT TIME ZONE 'America/Sao_Paulo')::date)::int days_since_last,
    count(*)>1 repeat_buyer
    FROM commerce.wholesale_orders o WHERE o.environment=$1 AND o.status='confirmed'
      AND (o.partner_transfer_status IS NULL OR o.partner_transfer_status IN ('settled','received'))
      AND (o.sold_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2::date AND $3::date
      AND ($4::uuid IS NULL OR o.buyer_id=$4) AND ($5='' OR EXISTS (SELECT 1 FROM commerce.wholesale_order_items i
        WHERE i.environment=o.environment AND i.order_id=o.id AND i.measure ILIKE '%'||$5||'%'))
    GROUP BY o.buyer_id`,'revenue_brl::numeric DESC,id',
    'Compradores identificados por código. Ranking e última compra dentro do período escolhido; ausência no período não comprova inatividade histórica.');
  if(view==='medidas')return readPage(ctx,`SELECT i.measure AS id,i.measure,i.tire_condition,
    sum(CASE WHEN o.partner_transfer_status IN ('settled','received') THEN COALESCE(i.accepted_quantity,0) ELSE i.quantity END)::int quantity,
    sum(CASE WHEN o.partner_transfer_status IN ('settled','received') THEN COALESCE(i.accepted_quantity,0) ELSE i.quantity END*i.unit_price)::text gross_items_brl,
    sum(CASE WHEN o.partner_transfer_status IN ('settled','received') THEN COALESCE(i.accepted_quantity,0) ELSE i.quantity END*i.unit_cost)::text known_cost_brl,
    count(*) FILTER(WHERE i.unit_cost IS NULL)::int pending_cost_items
    FROM commerce.wholesale_orders o JOIN commerce.wholesale_order_items i ON i.environment=o.environment AND i.order_id=o.id
    WHERE o.environment=$1 AND o.status='confirmed' AND i.tire_lot_id IS NULL
      AND (o.partner_transfer_status IS NULL OR o.partner_transfer_status IN ('settled','received'))
      AND (o.sold_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2::date AND $3::date
      AND ($4::uuid IS NULL OR o.buyer_id=$4) AND ($5='' OR i.measure ILIKE '%'||$5||'%')
    GROUP BY i.measure,i.tire_condition`,'quantity DESC,id,tire_condition',
    'Itens brutos antes de descontos do pedido; custo conhecido não equivale a lucro confirmado.');
  return readPage(ctx,`SELECT o.id,o.buyer_id,o.sold_at,o.status,o.payment_status,${paymentMethodSql('o.payment_method')} payment_method,o.due_date,o.paid_at,
    o.partner_transfer_status,o.is_lot_sale,COALESCE(o.settled_total_amount,o.total_amount)::text total_amount,
    (SELECT count(*)::int FROM commerce.wholesale_order_items i WHERE i.environment=o.environment AND i.order_id=o.id) items_count,
    COALESCE((SELECT jsonb_agg(x ORDER BY x.id) FROM (SELECT i.id,i.tire_lot_id,
      CASE WHEN i.tire_lot_id IS NULL THEN i.measure ELSE NULL END measure,i.brand,i.tire_condition,
      i.quantity dispatched_quantity,i.accepted_quantity,i.unit_price,i.unit_cost,i.line_total,i.line_profit
      FROM commerce.wholesale_order_items i WHERE i.environment=o.environment AND i.order_id=o.id ORDER BY i.id LIMIT 50) x),'[]') items
    FROM commerce.wholesale_orders o WHERE o.environment=$1
      AND (o.sold_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2::date AND $3::date
      AND ($4::uuid IS NULL OR o.id=$4) AND ($5='' OR EXISTS (SELECT 1 FROM commerce.wholesale_order_items i
        WHERE i.environment=o.environment AND i.order_id=o.id AND i.measure ILIKE '%'||$5||'%'))`,
  'sold_at DESC,id DESC','Transferência em trânsito não é receita realizada. Até 50 itens por venda; items_count informa o total.');
}

import { readPage, rejectFilters, type DotReadContext } from './read-model.js';
import { paymentMethodSql } from './safe-values.js';

export function readDotPurchases(ctx:DotReadContext,view:'compras'|'pedidos'|'fornecedores'|'precos') {
  if(view==='pedidos'||view==='fornecedores')rejectFilters(ctx,'medida');
  if(view==='pedidos')return readPage(ctx,`SELECT o.id,o.order_number,o.supplier_id,o.status,o.created_at,
    count(p.id)::int purchases_count,COALESCE(sum(p.total_amount) FILTER(WHERE p.status<>'cancelled'),0)::text total_amount
    FROM commerce.wholesale_purchase_orders o LEFT JOIN commerce.wholesale_purchases p
      ON p.environment=o.environment AND p.purchase_order_id=o.id
    WHERE o.environment=$1 AND ($4::uuid IS NULL OR o.id=$4) AND $5=''
    GROUP BY o.id`,'created_at DESC,id DESC','Pedidos de compra atuais, sem restringir pela data da criação.');
  if(view==='fornecedores')return readPage(ctx,`SELECT s.id,s.deleted_at IS NOT NULL archived,
    count(p.id) FILTER(WHERE p.status='confirmed')::int received_purchases,
    max(p.purchased_at) FILTER(WHERE p.status='confirmed') last_purchase_at,
    COALESCE(sum(p.total_amount) FILTER(WHERE p.status='confirmed'),0)::text purchases_brl,
    count(p.id) FILTER(WHERE p.status='pending')::int pending_receipts
    FROM commerce.wholesale_suppliers s LEFT JOIN commerce.wholesale_purchases p ON p.environment=s.environment
      AND p.supplier_id=s.id AND (p.purchased_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2::date AND $3::date
    WHERE s.environment=$1 AND ($4::uuid IS NULL OR s.id=$4) AND $5=''
    GROUP BY s.id`,'purchases_brl::numeric DESC,id','Fornecedores identificados por código; sem documentos, contatos ou notas livres.');
  if(view==='precos')return readPage(ctx,`SELECT i.measure AS id,p.supplier_id,i.measure,i.brand,i.tire_condition,i.vehicle_type,
    count(*)::int receipts,min(i.unit_cost)::text minimum_unit_cost,max(i.unit_cost)::text maximum_unit_cost,
    (sum(i.unit_cost*COALESCE(i.accepted_quantity,i.quantity))/NULLIF(sum(COALESCE(i.accepted_quantity,i.quantity)),0))::text weighted_unit_cost,
    max(p.purchased_at) last_purchase_at FROM commerce.wholesale_purchase_items i
    JOIN commerce.wholesale_purchases p ON p.environment=i.environment AND p.id=i.purchase_id
    WHERE i.environment=$1 AND p.status='confirmed' AND COALESCE(i.accepted_quantity,i.quantity)>0
      AND (p.purchased_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2::date AND $3::date
      AND ($4::uuid IS NULL OR p.supplier_id=$4) AND ($5='' OR i.measure ILIKE '%'||$5||'%')
    GROUP BY p.supplier_id,i.measure,i.brand,i.tire_condition,i.vehicle_type`,
  'last_purchase_at DESC,id,supplier_id,brand,tire_condition','Custos de compras recebidas; média ponderada pela quantidade aceita no período.');
  return readPage(ctx,`SELECT p.id,p.supplier_id,p.purchase_order_id,p.purchase_kind,p.status,p.purchased_at,p.stock_applied,
    p.products_amount,p.freight_amount,p.discount_amount,p.total_amount,p.payment_status,${paymentMethodSql('p.payment_method')} payment_method,p.due_date,p.paid_at,
    (SELECT count(*)::int FROM commerce.wholesale_purchase_lines i WHERE i.environment=p.environment AND i.purchase_id=p.id) items_count,
    COALESCE((SELECT jsonb_agg(x ORDER BY x.id) FROM (SELECT i.id,i.item_kind,
      CASE WHEN i.item_kind='catalog' THEN i.measure ELSE NULL END measure,i.brand,i.tire_condition,i.vehicle_type,
      i.quantity,i.accepted_quantity,i.unit_cost,i.line_total,i.allocated_cost FROM commerce.wholesale_purchase_lines i
      WHERE i.environment=p.environment AND i.purchase_id=p.id ORDER BY i.id LIMIT 50) x),'[]') items,
    COALESCE((SELECT jsonb_agg(x ORDER BY x.installment_number) FROM (SELECT i.installment_number,i.due_date,i.amount
      FROM commerce.wholesale_purchase_installments i WHERE i.environment=p.environment AND i.purchase_id=p.id
      ORDER BY i.installment_number LIMIT 50) x),'[]') installments
    FROM commerce.wholesale_purchases p WHERE p.environment=$1
      AND (p.purchased_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2::date AND $3::date
      AND ($4::uuid IS NULL OR p.id=$4) AND ($5='' OR EXISTS (SELECT 1 FROM commerce.wholesale_purchase_lines i
        WHERE i.environment=p.environment AND i.purchase_id=p.id AND i.measure ILIKE '%'||$5||'%'))`,
  'purchased_at DESC,id DESC','Compras no período; até 50 itens e parcelas por compra. Parcela programada não comprova pagamento.');
}

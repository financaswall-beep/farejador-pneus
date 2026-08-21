export const matrizCommissionFactsSql = `WITH retail AS (
  SELECT o.seller_collaborator_id collaborator_id,o.id::text id,
         'Pedido #'||COALESCE(o.order_number::text,right(o.id::text,6)) reference,
         o.created_at occurred_at,o.payment_method,o.total_amount gross_amount,
         COALESCE(items.margin,0) margin,COALESCE(items.items_without_cost,0) items_without_cost,
         'sale'::text event_type,'retail'::text sale_channel,o.id source_id
    FROM commerce.orders o
    JOIN core.units u ON u.id=o.unit_id AND u.environment=o.environment AND u.slug='main'
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum((oi.unit_price-oi.matriz_unit_cost)*oi.quantity-oi.discount_amount)
                 FILTER (WHERE oi.matriz_unit_cost IS NOT NULL),0) margin,
             count(*) FILTER (WHERE oi.matriz_unit_cost IS NULL)::int items_without_cost
        FROM commerce.order_items oi
       WHERE oi.environment=o.environment AND oi.order_id=o.id
    ) items ON true
   WHERE o.environment=$1 AND o.seller_collaborator_id IS NOT NULL
     AND o.status IN ('confirmed','paid','delivered')
     AND (o.created_at AT TIME ZONE 'America/Sao_Paulo') >= $2::date
     AND (o.created_at AT TIME ZONE 'America/Sao_Paulo') < $3::date
), wholesale AS (
  SELECT o.seller_collaborator_id collaborator_id,o.id::text id,
         'Atacado #'||right(o.id::text,6) reference,
         CASE WHEN o.partner_transfer_status IN ('settled','received')
           THEN COALESCE(o.partner_settled_at,o.sold_at) ELSE o.sold_at END occurred_at,
         NULL::text payment_method,COALESCE(o.settled_total_amount,o.total_amount) gross_amount,
         COALESCE(items.margin,0) margin,COALESCE(items.items_without_cost,0) items_without_cost,
         'sale'::text event_type,'wholesale'::text sale_channel,o.id source_id
    FROM commerce.wholesale_orders o
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum((oi.unit_price-oi.unit_cost)*CASE
               WHEN o.partner_transfer_status IN ('settled','received')
                 THEN COALESCE(oi.accepted_quantity,0) ELSE oi.quantity END),0) margin,
             count(*) FILTER (WHERE oi.unit_cost IS NULL)::int items_without_cost
        FROM commerce.wholesale_order_items oi
       WHERE oi.environment=o.environment AND oi.order_id=o.id
    ) items ON true
   WHERE o.environment=$1 AND o.seller_collaborator_id IS NOT NULL
     AND o.status='confirmed'
     AND (o.partner_transfer_status IS NULL
       OR o.partner_transfer_status IN ('settled','received'))
     AND ((CASE WHEN o.partner_transfer_status IN ('settled','received')
            THEN COALESCE(o.partner_settled_at,o.sold_at) ELSE o.sold_at END)
          AT TIME ZONE 'America/Sao_Paulo') >= $2::date
     AND ((CASE WHEN o.partner_transfer_status IN ('settled','received')
            THEN COALESCE(o.partner_settled_at,o.sold_at) ELSE o.sold_at END)
          AT TIME ZONE 'America/Sao_Paulo') < $3::date
), delivery_events AS (
  SELECT t.courier_collaborator_id collaborator_id,o.id::text id,
         'Entrega #'||COALESCE(o.order_number::text,right(o.id::text,6)) reference,
         o.delivered_at occurred_at,NULL::text payment_method,0::numeric gross_amount,
         0::numeric margin,0::int items_without_cost,'delivery'::text event_type,
         NULL::text sale_channel,o.id source_id
    FROM commerce.matriz_delivery_trips t
    JOIN commerce.orders o ON o.environment=t.environment AND o.trip_id=t.id
   WHERE t.environment=$1 AND t.courier_collaborator_id IS NOT NULL
     AND t.deleted_at IS NULL AND o.delivery_status='delivered' AND o.delivered_at IS NOT NULL
     AND (o.delivered_at AT TIME ZONE 'America/Sao_Paulo') >= $2::date
     AND (o.delivered_at AT TIME ZONE 'America/Sao_Paulo') < $3::date
), trip_events AS (
  SELECT t.courier_collaborator_id collaborator_id,t.id::text id,
         'Rota #'||right(t.id::text,6) reference,t.ended_at occurred_at,
         NULL::text payment_method,0::numeric gross_amount,0::numeric margin,
         0::int items_without_cost,'trip'::text event_type,NULL::text sale_channel,t.id source_id
    FROM commerce.matriz_delivery_trips t
   WHERE t.environment=$1 AND t.courier_collaborator_id IS NOT NULL
     AND t.deleted_at IS NULL AND t.status='closed' AND t.ended_at IS NOT NULL
     AND commerce.matriz_trip_financial_status(t.id,t.environment)='reconciled'
     AND (t.ended_at AT TIME ZONE 'America/Sao_Paulo') >= $2::date
     AND (t.ended_at AT TIME ZONE 'America/Sao_Paulo') < $3::date
), sales AS (
  SELECT * FROM retail UNION ALL SELECT * FROM wholesale
  UNION ALL SELECT * FROM delivery_events UNION ALL SELECT * FROM trip_events
), ruled AS (
  SELECT s.*,rule.kind commission_kind,rule.basis commission_basis,
         COALESCE(rule.value,0) commission_value,
         COALESCE(rule.itemized,false) commission_itemized,
         COALESCE(rule.item_rules,'{}'::jsonb) commission_item_rules,
         COALESCE(rule.settlement_frequency,'monthly') settlement_frequency,
         CASE
           WHEN rule.active AND rule.itemized AND s.sale_channel='retail'
             THEN finance.matriz_retail_itemized_commission($1,s.source_id,rule.item_rules)
           WHEN rule.active AND rule.itemized AND s.sale_channel='wholesale'
             THEN finance.matriz_wholesale_itemized_commission($1,s.source_id,rule.item_rules)
           WHEN rule.active AND rule.kind='percent' AND rule.basis='margin'
             THEN round(s.margin*rule.value/100,2)
           WHEN rule.active AND rule.kind='percent' AND rule.basis='revenue'
             THEN round(s.gross_amount*rule.value/100,2)
           WHEN rule.active AND rule.kind='fixed' AND rule.basis='sale' AND s.event_type='sale'
             THEN rule.value
           WHEN rule.active AND rule.kind='fixed' AND rule.basis='delivery' AND s.event_type='delivery'
             THEN rule.value
           WHEN rule.active AND rule.kind='fixed' AND rule.basis='trip' AND s.event_type='trip'
             THEN rule.value
           ELSE 0 END commission_amount
    FROM sales s
    LEFT JOIN LATERAL (
      SELECT r.kind,r.basis,r.value,r.active,r.itemized,r.item_rules,r.settlement_frequency
        FROM network.matriz_collaborator_commission_rules r
       WHERE r.environment=$1 AND r.collaborator_id=s.collaborator_id
         AND r.starts_on <= (s.occurred_at AT TIME ZONE 'America/Sao_Paulo')::date
       ORDER BY r.starts_on DESC LIMIT 1
    ) rule ON true
)`;

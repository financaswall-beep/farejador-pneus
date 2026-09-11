export const partnerUnitsSql=`SELECT pu.id,pu.partner_id,pu.unit_id,pu.display_name AS name,
  COALESCE(NULLIF(p.trade_name,''),p.legal_name) AS partner_name,NULLIF(trim(pu.address_city),'') AS city,
  NULLIF(trim(pu.address_neighborhood),'') AS neighborhood,
  CASE WHEN p.status<>'active' THEN p.status ELSE pu.status END AS status,
  (pu.deleted_at IS NOT NULL OR p.deleted_at IS NOT NULL) AS archived
  FROM network.partner_units pu JOIN network.partners p ON p.id=pu.partner_id AND p.environment=pu.environment
  WHERE pu.environment=$1 ORDER BY pu.partner_id,pu.id LIMIT 2001`;
const realizedDate=`(CASE WHEN po.fulfillment_mode='delivery' THEN po.delivered_at ELSE COALESCE(po.retrieved_at,po.created_at) END AT TIME ZONE 'America/Sao_Paulo')::date`;
export const partnerSalesSql=`SELECT po.id,po.unit_id,${realizedDate}::text AS day,po.source_tag AS source,po.fulfillment_mode AS mode,
  po.total_amount::float8 AS total,COALESCE(po.freight_amount,0)::float8 AS freight,
  COALESCE(items.quantity,0)::int AS quantity,COALESCE(items.items,'[]'::jsonb) AS items,ce.id AS commission_id
  FROM commerce.partner_orders po
  LEFT JOIN network.commission_entries ce ON ce.environment=po.environment::text AND ce.partner_order_id=po.id
  LEFT JOIN LATERAL(SELECT sum(oi.quantity) AS quantity,jsonb_agg(jsonb_build_object(
    'name',COALESCE(NULLIF(oi.item_name,''),ps.item_name,'Item sem cadastro'),'measure',ps.tire_size,'brand',ps.brand,
    'quantity',oi.quantity,'price',oi.unit_price,'total',oi.quantity*oi.unit_price-oi.discount_amount) ORDER BY oi.id) AS items
    FROM commerce.partner_order_items oi LEFT JOIN commerce.partner_stock_levels ps ON ps.id=oi.partner_stock_id AND ps.environment=oi.environment
    WHERE oi.order_id=po.id AND oi.environment=po.environment) items ON true
  WHERE po.environment=$1 AND po.status<>'cancelled' AND po.deleted_at IS NULL AND NOT po.awaiting_pickup
    AND NOT(po.fulfillment_mode='delivery' AND po.delivery_status<>'delivered')
    AND (${realizedDate} BETWEEN $2::date AND $3::date OR ${realizedDate} BETWEEN $4::date AND $5::date OR ${realizedDate} IS NULL)
  ORDER BY day DESC NULLS LAST,po.id LIMIT 20001`;
export const partnerCommissionsSql=`SELECT ce.id,ce.partner_id,ce.unit_id,ce.partner_order_id AS order_id,
  ce.order_total::float8 AS base,ce.commission_percent::float8 AS percent,ce.commission_amount::float8 AS amount,ce.status,
  (ce.realized_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS day,
  (ce.settled_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS settled_on,
  (ce.reversed_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS reversed_on,r.refund_status,
  COALESCE(r.amount,0)::float8 AS refund_amount,(r.refunded_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS refunded_on
  FROM network.commission_entries ce LEFT JOIN finance.matriz_commission_reversals r ON r.commission_entry_id=ce.id AND r.environment::text=ce.environment
  WHERE ce.environment=$1 AND ((ce.realized_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2::date AND $3::date
    OR (ce.realized_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $4::date AND $5::date
    OR (ce.settled_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2::date AND $3::date
    OR (ce.reversed_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2::date AND $3::date
    OR ce.status='open' OR r.refund_status='pending')
  ORDER BY ce.realized_at DESC,ce.id LIMIT 20001`;

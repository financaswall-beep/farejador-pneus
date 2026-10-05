-- Projeção de reposição para o parceiro: faltas da própria loja × saldo livre da 2W.
-- Não concede acesso às buscas, conversas, custos ou estoque completo da matriz.
BEGIN;

CREATE FUNCTION commerce.partner_replenishment_offers()
RETURNS TABLE (measure text,brand text,tire_condition text,vehicle_type text,
  quantity_available integer,demand_count integer,last_demand_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
WITH unit AS (
  SELECT pu.environment,pu.unit_id FROM network.partner_units pu
  JOIN network.partners p ON p.id=pu.partner_id AND p.environment=pu.environment
  WHERE pu.id=network.current_partner_unit() AND pu.status='active' AND p.status='active'
), events AS (
  -- A loja foi realmente consultada na região do cliente; não usa demanda global.
  SELECT s.environment,s.conversation_id,s.occurred_at AS at,s.measure,
    commerce.wholesale_measure_key(s.measure) AS measure_key,
    NULLIF(s.filters->>'condicao_pneu','') AS condition,
    NULLIF(s.filters->>'marca','') AS requested_brand,s.vehicle_type
  FROM ops.bot_stock_searches s JOIN unit u ON u.environment=s.environment
  WHERE s.occurred_at>=now()-interval '7 days' AND s.occurred_at<=now()
    AND s.stores @> jsonb_build_array(jsonb_build_object('id',u.unit_id::text,'available',false))
  UNION ALL
  -- NÃO TENHO em um pedido de uma medida é outra evidência física de falta.
  -- Em um conjunto, a resposta não identifica qual medida faltou: não atribuir a ambas.
  SELECT r.environment,r.conversation_id,r.answered_at,i->>'tire_size',
    commerce.wholesale_measure_key(i->>'tire_size'),NULLIF(i->>'tire_condition',''),
    NULL::text,NULL::text
  FROM commerce.partner_stock_requests r JOIN unit u
    ON u.environment=r.environment AND u.unit_id=r.unit_id
  CROSS JOIN LATERAL jsonb_array_elements(r.items) i
  WHERE r.status='rejected' AND r.sealed AND jsonb_array_length(r.items)=1
    AND r.answered_at>=now()-interval '7 days' AND r.answered_at<=now()
), missing AS (
  SELECT e.* FROM events e JOIN core.conversations c
    ON c.environment=e.environment AND c.id=e.conversation_id AND c.deleted_at IS NULL
  JOIN unit u ON u.environment=e.environment
  WHERE NULLIF(e.measure_key,'') IS NOT NULL
    AND NOT (c.additional_attributes ? 'farejador_demo_run')
    AND COALESCE(c.additional_attributes->>'farejador_simulator','false')<>'true'
    AND NOT EXISTS (
      SELECT 1 FROM commerce.partner_stock_levels s
      WHERE s.environment=u.environment AND s.unit_id=u.unit_id AND s.deleted_at IS NULL
        AND s.is_tracked AND s.quantity_on_hand-COALESCE(s.quantity_reserved,0)>0
        AND commerce.wholesale_measure_key(s.tire_size)=e.measure_key
        AND (e.condition IS NULL OR s.tire_condition=e.condition)
        AND (e.requested_brand IS NULL OR commerce.catalog_brand_identity(s.brand)=commerce.catalog_brand_identity(e.requested_brand))
        AND (e.vehicle_type IS NULL OR commerce.catalog_vehicle_type(s.environment,s.tire_size,s.brand,s.tire_condition)=e.vehicle_type)
    )
), eligible AS (
  SELECT m.* FROM missing m WHERE EXISTS (
    SELECT 1 FROM commerce.wholesale_stock w WHERE w.environment=m.environment
      AND commerce.wholesale_measure_key(w.measure)=m.measure_key
      AND w.quantity_on_hand-w.quantity_reserved>0
      AND (m.condition IS NULL OR w.tire_condition=m.condition)
      AND (m.requested_brand IS NULL OR commerce.catalog_brand_identity(w.brand)=commerce.catalog_brand_identity(m.requested_brand))
      AND (m.vehicle_type IS NULL OR COALESCE(w.vehicle_type,commerce.stock_vehicle_type(w.environment,w.measure,w.brand,w.tire_condition))=m.vehicle_type)
  )
), chosen AS (
  SELECT measure_key,min(measure) AS measure,count(DISTINCT conversation_id)::int AS demand_count,
    max(at) AS last_demand_at FROM eligible GROUP BY measure_key
  ORDER BY demand_count DESC,last_demand_at DESC,measure_key LIMIT 1
)
SELECT d.measure,w.brand,w.tire_condition,
  COALESCE(w.vehicle_type,commerce.stock_vehicle_type(w.environment,w.measure,w.brand,w.tire_condition)),
  sum(w.quantity_on_hand-w.quantity_reserved)::int,d.demand_count,d.last_demand_at
FROM chosen d JOIN commerce.wholesale_stock w ON commerce.wholesale_measure_key(w.measure)=d.measure_key
JOIN unit u ON u.environment=w.environment
WHERE w.quantity_on_hand-w.quantity_reserved>0 AND EXISTS (
  SELECT 1 FROM eligible m WHERE m.measure_key=d.measure_key
    AND (m.condition IS NULL OR w.tire_condition=m.condition)
    AND (m.requested_brand IS NULL OR commerce.catalog_brand_identity(w.brand)=commerce.catalog_brand_identity(m.requested_brand))
    AND (m.vehicle_type IS NULL OR COALESCE(w.vehicle_type,commerce.stock_vehicle_type(w.environment,w.measure,w.brand,w.tire_condition))=m.vehicle_type)
)
GROUP BY d.measure,w.brand,w.tire_condition,
  COALESCE(w.vehicle_type,commerce.stock_vehicle_type(w.environment,w.measure,w.brand,w.tire_condition)),
  d.demand_count,d.last_demand_at
ORDER BY w.tire_condition,w.brand;
$$;
REVOKE ALL ON FUNCTION commerce.partner_replenishment_offers() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.partner_replenishment_offers() TO farejador_partner_app;
COMMENT ON FUNCTION commerce.partner_replenishment_offers() IS
  'Somente leitura; contexto da unidade, janela de 7 dias, conversas distintas e saldo livre. Sem identificação de clientes ou preço/custo interno.';
COMMIT;

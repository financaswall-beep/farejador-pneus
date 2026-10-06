-- Consulta do parceiro: somente ofertas de atacado publicadas e saldo livre.
-- Não muda as fontes de preço/estoque usadas pelo bot ou concede SELECT nas tabelas da matriz.
CREATE FUNCTION commerce.partner_wholesale_catalog()
RETURNS TABLE (offer_key uuid,measure text,brand text,tire_condition text,
  vehicle_type text,quantity_available integer,price_cents bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
WITH unit AS (
  SELECT pu.environment FROM network.partner_units pu
  JOIN network.partners p ON p.id=pu.partner_id AND p.environment=pu.environment
  WHERE pu.id=network.current_partner_unit() AND pu.status='active' AND p.status='active'
), variants AS (
  SELECT p.id,p.environment,ts.tire_size,p.brand,p.tire_condition,ts.vehicle_type,
    commerce.catalog_measure_identity(ts.tire_size) AS measure_key,
    commerce.catalog_brand_identity(p.brand) AS brand_key,
    count(*) OVER (PARTITION BY p.environment,commerce.catalog_measure_identity(ts.tire_size),
      commerce.catalog_brand_identity(p.brand),p.tire_condition) AS variant_count
  FROM commerce.products p JOIN unit u ON u.environment=p.environment
  JOIN commerce.tire_specs ts ON ts.environment=p.environment AND ts.product_id=p.id
  WHERE p.product_type='tire' AND p.deleted_at IS NULL
)
SELECT v.id,v.tire_size,v.brand,v.tire_condition,
  COALESCE(v.vehicle_type,w.vehicle_type),w.available, (wp.price_amount*100)::bigint
FROM variants v
JOIN commerce.wholesale_current_prices wp ON wp.environment=v.environment AND wp.product_id=v.id
JOIN LATERAL (
  -- Duplicatas normalizadas são ambíguas; não somar nem anunciar o mesmo saldo duas vezes.
  SELECT min(s.quantity_on_hand-s.quantity_reserved)::integer AS available,
    min(s.vehicle_type) AS vehicle_type
  FROM commerce.wholesale_stock s
  WHERE s.environment=v.environment
    AND commerce.catalog_measure_identity(s.measure)=v.measure_key
    AND commerce.catalog_brand_identity(s.brand)=v.brand_key AND s.tire_condition=v.tire_condition
  HAVING count(*)=1
) w ON w.available>0
WHERE v.variant_count=1 AND NULLIF(v.measure_key,'') IS NOT NULL
  AND COALESCE(v.vehicle_type,w.vehicle_type) IN ('motorcycle','car')
  AND (v.vehicle_type IS NULL OR w.vehicle_type IS NULL OR v.vehicle_type=w.vehicle_type)
ORDER BY v.tire_size,v.tire_condition,v.brand,v.id;
$$;
REVOKE ALL ON FUNCTION commerce.partner_wholesale_catalog() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.partner_wholesale_catalog() TO farejador_partner_app;
COMMENT ON FUNCTION commerce.partner_wholesale_catalog() IS
  'Leitura para unidade parceira ativa: variante inequívoca, preço de atacado vigente e saldo físico menos reservas. Sem custo, margem, cliente ou dados de outra unidade/ambiente.';

-- Demonstração temporária solicitada para parceiro.teste.
-- Não fabrica conversas, buscas do bot, procura analítica ou saldo de estoque.
BEGIN;

DO $$ BEGIN
  IF to_regprocedure('commerce.partner_replenishment_live_offers()') IS NULL THEN
    ALTER FUNCTION commerce.partner_replenishment_offers() RENAME TO partner_replenishment_live_offers;
  END IF;
END $$;
REVOKE ALL ON FUNCTION commerce.partner_replenishment_live_offers() FROM PUBLIC, farejador_partner_app;

CREATE OR REPLACE FUNCTION commerce.partner_replenishment_offers()
RETURNS TABLE (measure text,brand text,tire_condition text,vehicle_type text,
  quantity_available integer,demand_count integer,last_demand_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  v_environment text;
  v_unit_id uuid;
  v_payload jsonb;
  v_created_at timestamptz;
BEGIN
  -- O motor real da 0265 continua sendo a fonte prioritária, sem alteração.
  RETURN QUERY SELECT * FROM commerce.partner_replenishment_live_offers();
  IF FOUND THEN RETURN; END IF;

  SELECT pu.environment::text,pu.unit_id INTO v_environment,v_unit_id
  FROM network.partner_units pu
  JOIN network.partners p ON p.id=pu.partner_id AND p.environment=pu.environment
  WHERE pu.id=network.current_partner_unit() AND pu.slug='teste-app-parceiro-0410'
    AND pu.status='active' AND p.status='active' AND pu.deleted_at IS NULL AND p.deleted_at IS NULL
    AND NOT pu.accepts_network_orders AND p.commission_percent=0
    AND EXISTS(SELECT 1 FROM network.partner_access_tokens t
      WHERE t.environment=pu.environment AND t.partner_unit_id=pu.id
        AND t.login_username='parceiro.teste' AND t.role='owner' AND t.revoked_at IS NULL);
  IF NOT FOUND THEN RETURN; END IF;

  -- Evento auditável e imutável. O exemplo desaparece sozinho após duas horas.
  SELECT e.payload_after,e.created_at INTO v_payload,v_created_at
  FROM audit.events e
  WHERE e.environment::text=v_environment AND e.domain='network'
    AND e.entity_table='network.partner_units' AND e.entity_id=network.current_partner_unit()
    AND e.event_type='partner_replenishment_demo_created'
    AND e.created_at>now()-interval '2 hours' AND e.created_at<=now()
  ORDER BY e.created_at DESC,e.id DESC LIMIT 1;
  IF NOT FOUND OR v_payload->>'simulation' IS DISTINCT FROM 'true' THEN RETURN; END IF;

  RETURN QUERY
  WITH requested AS (
    SELECT d->>'measure' AS measure,d->>'tire_condition' AS tire_condition,
      max((d->>'demand_count')::int) AS demand_count
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_payload->'measures')='array'
      THEN v_payload->'measures' ELSE '[]'::jsonb END) d
    WHERE d->>'demand_count' ~ '^[1-9][0-9]{0,2}$'
      AND d->>'tire_condition' IN ('novo','meia_vida','remold')
      AND NULLIF(commerce.wholesale_measure_key(d->>'measure'),'') IS NOT NULL
    GROUP BY d->>'measure',d->>'tire_condition'
  )
  SELECT w.measure,w.brand,w.tire_condition,
    COALESCE(w.vehicle_type,commerce.stock_vehicle_type(w.environment,w.measure,w.brand,w.tire_condition)),
    sum(w.quantity_on_hand-w.quantity_reserved)::int,r.demand_count,v_created_at
  FROM requested r JOIN commerce.wholesale_stock w
    ON w.environment::text=v_environment AND w.tire_condition=r.tire_condition
      AND commerce.wholesale_measure_key(w.measure)=commerce.wholesale_measure_key(r.measure)
  WHERE w.quantity_on_hand>w.quantity_reserved
    AND NOT EXISTS(SELECT 1 FROM commerce.partner_stock_levels s
      WHERE s.environment=w.environment AND s.unit_id=v_unit_id AND s.deleted_at IS NULL
        AND s.is_tracked AND s.quantity_on_hand-COALESCE(s.quantity_reserved,0)>0
        AND s.tire_condition=w.tire_condition
        AND commerce.wholesale_measure_key(s.tire_size)=commerce.wholesale_measure_key(w.measure))
  GROUP BY w.measure,w.brand,w.tire_condition,w.vehicle_type,w.environment,r.demand_count
  ORDER BY r.demand_count DESC,w.measure,w.brand;
END $$;
REVOKE ALL ON FUNCTION commerce.partner_replenishment_offers() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.partner_replenishment_offers() TO farejador_partner_app;
COMMENT ON FUNCTION commerce.partner_replenishment_offers() IS
  'Procura real da 0265; somente parceiro.teste isolado admite exemplo auditado por 2h, com saldo real do galpão. Sem escrita em raw/core/analytics ou estoque.';
COMMIT;

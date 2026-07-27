-- 0147 - Ajustes manuais do galpao passam a produzir efeito financeiro.
-- Compra/venda continuam nos seus livros causais. Esta tabela cobre somente
-- entrada avulsa, inventario, baixa manual e remocao de medida.

CREATE TABLE finance.matriz_inventory_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment env_t NOT NULL,
  stock_movement_id UUID NOT NULL
    REFERENCES commerce.wholesale_stock_movements(id),
  measure TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('gain','loss')),
  nature TEXT NOT NULL CHECK (nature IN (
    'inventory_found','owner_contribution','opening_balance','other',
    'breakage','loss','internal_use','inventory_count',
    'inventory_writeoff','legacy_unclassified'
  )),
  quantity_delta INTEGER NOT NULL,
  value_before NUMERIC(14,2) NOT NULL CHECK (value_before>=0),
  value_after NUMERIC(14,2) NOT NULL CHECK (value_after>=0),
  amount NUMERIC(14,2) NOT NULL CHECK (amount>0),
  source TEXT NOT NULL,
  reason TEXT,
  movement_ref TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT matriz_inventory_adjustments_movement_uniq
    UNIQUE (environment,stock_movement_id),
  CONSTRAINT matriz_inventory_adjustments_value_direction_check CHECK (
    (direction='gain' AND value_after>value_before)
    OR (direction='loss' AND value_after<value_before)
  )
);

CREATE INDEX matriz_inventory_adjustments_period_idx
  ON finance.matriz_inventory_adjustments(environment,occurred_at,direction);

CREATE TRIGGER env_match_matriz_inventory_adjustment_movement
  BEFORE INSERT OR UPDATE OF stock_movement_id
  ON finance.matriz_inventory_adjustments
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match(
    'commerce','wholesale_stock_movements','stock_movement_id');

CREATE OR REPLACE FUNCTION finance.guard_matriz_inventory_adjustment()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'inventory_adjustment_immutable';
END
$fn$;

CREATE TRIGGER matriz_inventory_adjustment_immutable
  BEFORE UPDATE OR DELETE ON finance.matriz_inventory_adjustments
  FOR EACH ROW EXECUTE FUNCTION finance.guard_matriz_inventory_adjustment();

CREATE OR REPLACE FUNCTION finance.record_matriz_inventory_adjustment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, finance
AS $fn$
DECLARE
  v_nature TEXT := NULLIF(current_setting('app.galpao_nature',true),'');
  v_before NUMERIC(14,2);
  v_after NUMERIC(14,2);
BEGIN
  IF NEW.source NOT IN ('entrada','baixa_manual','definir','remocao') THEN
    RETURN NEW;
  END IF;

  IF NEW.source='entrada' THEN
    IF v_nature NOT IN (
      'inventory_found','owner_contribution','opening_balance','other'
    ) THEN
      RAISE EXCEPTION 'stock_entry_nature_required';
    END IF;
  ELSIF NEW.source='baixa_manual' THEN
    IF v_nature NOT IN ('breakage','loss','internal_use','other') THEN
      RAISE EXCEPTION 'stock_decrement_nature_required';
    END IF;
  ELSIF NEW.source='definir' THEN
    v_nature := 'inventory_count';
  ELSE
    v_nature := 'inventory_writeoff';
  END IF;

  v_before := round(NEW.qty_before*COALESCE(NEW.cost_before,0),2);
  v_after := round(NEW.qty_after*COALESCE(NEW.cost_after,0),2);
  IF v_before=v_after THEN RETURN NEW; END IF;

  INSERT INTO finance.matriz_inventory_adjustments
    (environment,stock_movement_id,measure,direction,nature,quantity_delta,
     value_before,value_after,amount,source,reason,movement_ref,occurred_at)
  VALUES
    (NEW.environment,NEW.id,NEW.measure,
     CASE WHEN v_after>v_before THEN 'gain' ELSE 'loss' END,
     v_nature,NEW.qty_delta,v_before,v_after,abs(v_after-v_before),
     NEW.source,NEW.reason,NEW.ref,NEW.created_at)
  ON CONFLICT (environment,stock_movement_id) DO NOTHING;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER record_matriz_inventory_adjustment
  AFTER INSERT ON commerce.wholesale_stock_movements
  FOR EACH ROW EXECUTE FUNCTION finance.record_matriz_inventory_adjustment();

-- O legado nao tinha natureza estruturada. Ele continua visivel e conciliavel
-- como legacy_unclassified, sem inventar uma classificacao.
INSERT INTO finance.matriz_inventory_adjustments
  (environment,stock_movement_id,measure,direction,nature,quantity_delta,
   value_before,value_after,amount,source,reason,movement_ref,occurred_at)
SELECT m.environment,m.id,m.measure,
       CASE WHEN values_calc.value_after>values_calc.value_before
         THEN 'gain' ELSE 'loss' END,
       CASE
         WHEN m.source='baixa_manual' AND lower(COALESCE(m.reason,'')) LIKE 'quebra%'
           THEN 'breakage'
         WHEN m.source='baixa_manual' AND lower(COALESCE(m.reason,'')) LIKE 'perda%'
           THEN 'loss'
         WHEN m.source='baixa_manual' AND lower(COALESCE(m.reason,'')) LIKE 'uso interno%'
           THEN 'internal_use'
         WHEN m.source='definir' THEN 'inventory_count'
         WHEN m.source='remocao' THEN 'inventory_writeoff'
         ELSE 'legacy_unclassified'
       END,
       m.qty_delta,values_calc.value_before,values_calc.value_after,
       abs(values_calc.value_after-values_calc.value_before),
       m.source,m.reason,m.ref,m.created_at
  FROM commerce.wholesale_stock_movements m
 CROSS JOIN LATERAL (
   SELECT round(m.qty_before*COALESCE(m.cost_before,0),2) AS value_before,
          round(m.qty_after*COALESCE(m.cost_after,0),2) AS value_after
 ) values_calc
 WHERE m.source IN ('entrada','baixa_manual','definir','remocao')
   AND values_calc.value_before<>values_calc.value_after
ON CONFLICT (environment,stock_movement_id) DO NOTHING;

REVOKE ALL ON finance.matriz_inventory_adjustments FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.record_matriz_inventory_adjustment() FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.guard_matriz_inventory_adjustment() FROM PUBLIC;

DO $security$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='farejador_partner_app') THEN
    REVOKE ALL ON finance.matriz_inventory_adjustments FROM farejador_partner_app;
    REVOKE ALL ON FUNCTION finance.record_matriz_inventory_adjustment()
      FROM farejador_partner_app;
    REVOKE ALL ON FUNCTION finance.guard_matriz_inventory_adjustment()
      FROM farejador_partner_app;
  END IF;
END
$security$;

COMMENT ON TABLE finance.matriz_inventory_adjustments IS
  '0147: efeito financeiro imutavel de entrada/ajuste/baixa/remocao manual do galpao; uma linha por movimento 0128.';

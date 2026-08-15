-- 0173 - Comissao por grupo de item para a Operacao da Loja.
--
-- Compatibilidade:
-- - regras anteriores continuam com itemized=false e preservam o calculo por venda;
-- - somente regras novas, salvas pela Operacao, usam Pneus/Servicos/Outros;
-- - o livro do parceiro congela as regras e o valor no momento da realizacao;
-- - folhas ja fechadas permanecem imutaveis.

CREATE OR REPLACE FUNCTION network.valid_operation_commission_item_rules(p_rules JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_group TEXT;
  v_kind TEXT;
  v_value NUMERIC;
BEGIN
  IF p_rules IS NULL OR jsonb_typeof(p_rules) <> 'object'
     OR NOT (p_rules ? 'tire' AND p_rules ? 'service' AND p_rules ? 'other')
     OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(p_rules) AS keys(item_key)
        WHERE item_key NOT IN ('tire','service','other')
     ) THEN
    RETURN false;
  END IF;

  FOREACH v_group IN ARRAY ARRAY['tire','service','other'] LOOP
    IF jsonb_typeof(p_rules->v_group) <> 'object' THEN RETURN false; END IF;
    v_kind := p_rules->v_group->>'kind';
    IF v_kind NOT IN ('percent','fixed','none') THEN RETURN false; END IF;
    BEGIN
      v_value := (p_rules->v_group->>'value')::numeric;
    EXCEPTION WHEN OTHERS THEN
      RETURN false;
    END;
    IF v_value < 0 OR (v_kind='percent' AND v_value>100)
       OR (v_kind='fixed' AND v_group<>'tire')
       OR (v_kind='none' AND v_value<>0) THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END;
$function$;

ALTER TABLE network.matriz_collaborator_commission_rules
  ADD COLUMN IF NOT EXISTS itemized BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS item_rules JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE network.matriz_collaborator_commission_rules
  DROP CONSTRAINT IF EXISTS matriz_collaborator_commission_item_rules_check;
ALTER TABLE network.matriz_collaborator_commission_rules
  ADD CONSTRAINT matriz_collaborator_commission_item_rules_check
  CHECK (NOT itemized OR network.valid_operation_commission_item_rules(item_rules));

ALTER TABLE network.partner_token_commission
  ADD COLUMN IF NOT EXISTS itemized BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS item_rules JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE network.partner_token_commission
  DROP CONSTRAINT IF EXISTS partner_token_commission_item_rules_check;
ALTER TABLE network.partner_token_commission
  ADD CONSTRAINT partner_token_commission_item_rules_check
  CHECK (NOT itemized OR network.valid_operation_commission_item_rules(item_rules));

ALTER TABLE network.partner_token_commission_history
  ADD COLUMN IF NOT EXISTS itemized BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS item_rules JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE network.partner_token_commission_history
  DROP CONSTRAINT IF EXISTS partner_token_commission_history_item_rules_check;
ALTER TABLE network.partner_token_commission_history
  ADD CONSTRAINT partner_token_commission_history_item_rules_check
  CHECK (NOT itemized OR network.valid_operation_commission_item_rules(item_rules));

ALTER TABLE finance.partner_staff_commission_entries
  ADD COLUMN IF NOT EXISTS commission_itemized BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS commission_rules JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE finance.partner_staff_commission_entries
  DROP CONSTRAINT IF EXISTS partner_staff_commission_entry_rules_check;
ALTER TABLE finance.partner_staff_commission_entries
  ADD CONSTRAINT partner_staff_commission_entry_rules_check
  CHECK (NOT commission_itemized
    OR network.valid_operation_commission_item_rules(commission_rules));

CREATE OR REPLACE FUNCTION finance.operation_item_rule_amount(
  p_rules JSONB,
  p_group TEXT,
  p_quantity NUMERIC,
  p_revenue NUMERIC
)
RETURNS NUMERIC
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_kind TEXT := p_rules->p_group->>'kind';
  v_value NUMERIC := COALESCE((p_rules->p_group->>'value')::numeric,0);
BEGIN
  IF v_kind='fixed' AND p_group='tire' THEN
    RETURN round(GREATEST(COALESCE(p_quantity,0),0)*v_value,2);
  END IF;
  IF v_kind='percent' THEN
    RETURN round(GREATEST(COALESCE(p_revenue,0),0)*v_value/100.0,2);
  END IF;
  RETURN 0;
EXCEPTION WHEN OTHERS THEN
  RETURN 0;
END;
$function$;

CREATE OR REPLACE FUNCTION finance.matriz_retail_itemized_commission(
  p_environment env_t,
  p_order_id UUID,
  p_rules JSONB
)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $function$
  SELECT round(COALESCE(sum(finance.operation_item_rule_amount(
    p_rules,
    CASE p.product_type WHEN 'tire' THEN 'tire' WHEN 'service' THEN 'service' ELSE 'other' END,
    oi.quantity,
    GREATEST(oi.unit_price*oi.quantity-oi.discount_amount,0)
  )),0),2)
    FROM commerce.order_items oi
    JOIN commerce.products p ON p.environment=oi.environment AND p.id=oi.product_id
   WHERE oi.environment=p_environment AND oi.order_id=p_order_id;
$function$;

CREATE OR REPLACE FUNCTION finance.matriz_wholesale_itemized_commission(
  p_environment env_t,
  p_order_id UUID,
  p_rules JSONB
)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $function$
  SELECT round(COALESCE(sum(finance.operation_item_rule_amount(
    p_rules,'tire',oi.quantity,oi.line_total
  )),0),2)
    FROM commerce.wholesale_order_items oi
   WHERE oi.environment=p_environment AND oi.order_id=p_order_id;
$function$;

CREATE OR REPLACE FUNCTION finance.partner_itemized_commission(
  p_environment env_t,
  p_order_id UUID,
  p_rules JSONB
)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $function$
  SELECT round(COALESCE(sum(finance.operation_item_rule_amount(
    p_rules,
    CASE COALESCE(oi.item_type,'pneu') WHEN 'pneu' THEN 'tire'
         WHEN 'servico' THEN 'service' ELSE 'other' END,
    oi.quantity,
    GREATEST(oi.unit_price*oi.quantity-oi.discount_amount,0)
  )),0),2)
    FROM commerce.partner_order_items oi
   WHERE oi.environment=p_environment AND oi.order_id=p_order_id;
$function$;

-- O trigger original e o reparo mensal continuam sendo a unica porta de INSERT.
-- Este BEFORE INSERT troca apenas o calculo quando a regra atual e itemizada e
-- congela o JSON usado no mesmo livro imutavel.
CREATE OR REPLACE FUNCTION finance.snapshot_partner_itemized_commission()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $function$
DECLARE
  v_rule RECORD;
BEGIN
  -- A venda usa a regra vigente na data em que foi realizada. O historico e
  -- preferido para que uma alteracao futura nunca reescreva o passado; a
  -- configuracao corrente e apenas fallback para contas legadas sem historico.
  SELECT kind,value,active,itemized,item_rules INTO v_rule
    FROM network.partner_token_commission_history
   WHERE environment=NEW.environment AND token_id=NEW.token_id
     AND starts_on<=(NEW.realized_at AT TIME ZONE 'America/Sao_Paulo')::date
     AND updated_at<=NEW.realized_at
   ORDER BY starts_on DESC
   LIMIT 1;
  IF v_rule.kind IS NULL THEN
    SELECT kind,value,active,itemized,item_rules INTO v_rule
      FROM network.partner_token_commission
     WHERE environment=NEW.environment AND token_id=NEW.token_id
       AND updated_at<=NEW.realized_at
     LIMIT 1;
  END IF;

  IF v_rule.kind IS NULL OR NOT COALESCE(v_rule.active,false) THEN
    RETURN NEW;
  ELSIF COALESCE(v_rule.itemized,false) THEN
    NEW.commission_itemized := true;
    NEW.commission_rules := v_rule.item_rules;
    NEW.commission_amount := finance.partner_itemized_commission(
      NEW.environment,NEW.partner_order_id,v_rule.item_rules);
  ELSE
    NEW.commission_itemized := false;
    NEW.commission_rules := '{}'::jsonb;
    NEW.commission_kind := v_rule.kind;
    NEW.commission_value := v_rule.value;
    NEW.commission_amount := CASE WHEN v_rule.kind='percent'
      THEN round(NEW.gross_amount*v_rule.value/100.0,2)
      ELSE v_rule.value END;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS partner_staff_commission_itemized_snapshot
  ON finance.partner_staff_commission_entries;
CREATE TRIGGER partner_staff_commission_itemized_snapshot
BEFORE INSERT ON finance.partner_staff_commission_entries
FOR EACH ROW EXECUTE FUNCTION finance.snapshot_partner_itemized_commission();

-- As duas novas colunas tambem fazem parte do fato congelado. Sem substituir
-- este guard seria possivel alterar o JSON da regra depois da venda sem que o
-- bloqueio de imutabilidade percebesse.
CREATE OR REPLACE FUNCTION finance.guard_partner_staff_commission_fact()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'partner_staff_commission_fact_immutable';
  END IF;
  IF ROW(NEW.environment,NEW.partner_unit_id,NEW.unit_id,NEW.token_id,
         NEW.partner_order_id,NEW.competence_month,NEW.gross_amount,
         NEW.commission_kind,NEW.commission_value,NEW.commission_amount,
         NEW.commission_itemized,NEW.commission_rules,
         NEW.realized_at,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.environment,OLD.partner_unit_id,OLD.unit_id,OLD.token_id,
         OLD.partner_order_id,OLD.competence_month,OLD.gross_amount,
         OLD.commission_kind,OLD.commission_value,OLD.commission_amount,
         OLD.commission_itemized,OLD.commission_rules,
         OLD.realized_at,OLD.created_at) THEN
    RAISE EXCEPTION 'partner_staff_commission_fact_immutable';
  END IF;
  RETURN NEW;
END;
$function$;

-- O estorno da Matriz precisa usar exatamente a mesma regra itemizada usada no
-- fechamento. A funcao central recebe o evento e corrige o valor antes de criar
-- a deducao; entrega/rota e regras legadas seguem intactas.
CREATE OR REPLACE FUNCTION finance.insert_matriz_causal_adjustment(
  p_environment env_t,
  p_collaborator_id UUID,
  p_source_type TEXT,
  p_source_id UUID,
  p_source_event_at TIMESTAMPTZ,
  p_original_item_id UUID,
  p_amount NUMERIC,
  p_calculation JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, finance, audit
AS $function$
DECLARE
  v_id UUID;
  v_competence DATE;
  v_key TEXT;
  v_status TEXT;
  v_amount NUMERIC := p_amount;
  v_calculation JSONB := COALESCE(p_calculation,'{}'::jsonb);
  v_rule RECORD;
  v_snapshot_rules JSONB;
BEGIN
  IF p_source_type IN ('retail_sale_cancellation','wholesale_sale_cancellation') THEN
    -- Primeiro usa o snapshot da folha fechada. Isso evita que editar hoje
    -- uma regra com a mesma vigencia mude o valor de um estorno antigo.
    SELECT item.calculation #> '{rule,item_rules}' INTO v_snapshot_rules
      FROM finance.matriz_payroll_items item
     WHERE item.environment=p_environment AND item.id=p_original_item_id
       AND COALESCE((item.calculation #>> '{rule,itemized}')::boolean,false);
    IF v_snapshot_rules IS NULL THEN
      SELECT r.itemized,r.item_rules INTO v_rule
        FROM network.matriz_collaborator_commission_rules r
       WHERE r.environment=p_environment AND r.collaborator_id=p_collaborator_id
         AND r.starts_on<=(p_source_event_at AT TIME ZONE 'America/Sao_Paulo')::date
         AND r.active
       ORDER BY r.starts_on DESC LIMIT 1;
      IF COALESCE(v_rule.itemized,false) THEN
        v_snapshot_rules := v_rule.item_rules;
      END IF;
    END IF;
    IF v_snapshot_rules IS NOT NULL THEN
      v_amount := CASE p_source_type
        WHEN 'retail_sale_cancellation' THEN
          finance.matriz_retail_itemized_commission(p_environment,p_source_id,v_snapshot_rules)
        ELSE finance.matriz_wholesale_itemized_commission(p_environment,p_source_id,v_snapshot_rules)
      END;
      v_calculation := v_calculation || jsonb_build_object(
        'itemized',true,'item_rules',v_snapshot_rules,'commission_amount',v_amount);
    END IF;
  END IF;

  IF v_amount IS NOT NULL AND round(v_amount,2) <= 0 THEN RETURN NULL; END IF;
  v_competence := finance.next_open_matriz_payroll_competence(
    p_environment,(current_timestamp AT TIME ZONE 'America/Sao_Paulo')::date);
  v_key := 'payroll-causal:' || p_source_type || ':' || p_source_id::text
    || ':' || p_collaborator_id::text || ':' || p_original_item_id::text;
  v_status := CASE WHEN v_amount IS NULL THEN 'needs_review' ELSE 'ready' END;

  INSERT INTO finance.matriz_payroll_adjustments
    (environment,collaborator_id,competence,kind,description,amount,created_by,
     source_type,source_id,source_event_at,original_payroll_item_id,
     frozen_calculation,causal_status,idempotency_key)
  VALUES
    (p_environment,p_collaborator_id,v_competence,'deduction',
     CASE p_source_type
       WHEN 'delivery_cancellation' THEN 'Estorno causal: entrega cancelada apos folha'
       ELSE 'Estorno causal: venda cancelada apos folha' END,
     CASE WHEN v_amount IS NULL THEN NULL ELSE round(v_amount,2) END,
     'causal-trigger-0143',p_source_type,p_source_id,p_source_event_at,
     p_original_item_id,v_calculation,v_status,v_key)
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NOT NULL THEN
    INSERT INTO audit.events
      (environment,domain,entity_table,entity_id,event_type,actor_label,
       idempotency_key,payload_before,payload_after)
    VALUES
      (p_environment::text,'matriz_payroll','finance.matriz_payroll_adjustments',v_id,
       'causal_adjustment_created','causal-trigger-0143',v_key,NULL,
       jsonb_build_object('source_type',p_source_type,'source_id',p_source_id,
         'original_payroll_item_id',p_original_item_id,'competence',v_competence,
         'amount',v_amount,'causal_status',v_status));
  END IF;
  RETURN v_id;
END;
$function$;

REVOKE ALL ON FUNCTION network.valid_operation_commission_item_rules(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.operation_item_rule_amount(JSONB,TEXT,NUMERIC,NUMERIC) FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.matriz_retail_itemized_commission(env_t,UUID,JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.matriz_wholesale_itemized_commission(env_t,UUID,JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.partner_itemized_commission(env_t,UUID,JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.snapshot_partner_itemized_commission() FROM PUBLIC;

DO $assertions$
BEGIN
  IF NOT network.valid_operation_commission_item_rules(
    '{"tire":{"kind":"fixed","value":10},"service":{"kind":"percent","value":5},"other":{"kind":"none","value":0}}'::jsonb
  ) THEN RAISE EXCEPTION '0173 valid item rules rejected'; END IF;
  IF network.valid_operation_commission_item_rules(
    '{"tire":{"kind":"fixed","value":10},"service":{"kind":"fixed","value":10},"other":{"kind":"none","value":0}}'::jsonb
  ) THEN RAISE EXCEPTION '0173 fixed service rule accepted'; END IF;
END;
$assertions$;

COMMENT ON COLUMN network.matriz_collaborator_commission_rules.item_rules IS
  'Regras itemizadas da Operacao: tire aceita percentual ou fixo por unidade; service/other aceitam percentual ou nenhum.';
COMMENT ON COLUMN finance.partner_staff_commission_entries.commission_rules IS
  'Snapshot imutavel das regras por grupo usadas para calcular a comissao desta venda.';

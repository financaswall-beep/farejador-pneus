-- Cancelar um pedido preserva a procura e a etapa alcançada, mas não uma compra.
-- Classificações corrigidas são novas revisões; as anteriores ficam auditáveis.
BEGIN;

ALTER TABLE analytics.conversation_classifications
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  ADD COLUMN IF NOT EXISTS superseded_by uuid REFERENCES analytics.conversation_classifications(id);
ALTER TABLE analytics.conversation_classifications DROP CONSTRAINT classifications_dedup_key;
ALTER TABLE analytics.conversation_classifications ADD CONSTRAINT classifications_dedup_key
  UNIQUE (environment, conversation_id, dimension, source, extractor_version, ruleset_hash, revision);
CREATE INDEX IF NOT EXISTS classifications_superseded_idx
  ON analytics.conversation_classifications(superseded_by) WHERE superseded_by IS NOT NULL;
COMMENT ON COLUMN analytics.conversation_classifications.revision IS
  'Revisão de uma classificação. A revisão zero mantém a compatibilidade dos extratores anteriores.';
COMMENT ON CONSTRAINT classifications_dedup_key ON analytics.conversation_classifications IS
  'Deduplica cada revisão do extrator; mudanças de estado SQL acrescentam revisões e preservam o histórico.';

CREATE OR REPLACE VIEW analytics.current_classifications AS
SELECT DISTINCT ON (environment, conversation_id, dimension)
  id, environment, conversation_id, dimension, value, truth_type, source,
  confidence_level, extractor_version, notes, created_at
FROM analytics.conversation_classifications
WHERE superseded_by IS NULL AND NOT (dimension = 'loss_reason' AND value = 'nao_se_aplica')
ORDER BY environment, conversation_id, dimension, created_at DESC, revision DESC, id DESC;

CREATE OR REPLACE FUNCTION analytics._insert_classification(
  p_env text, p_conv_id uuid, p_dimension text, p_value text
) RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  v_id uuid;
  v_previous analytics.conversation_classifications%ROWTYPE;
  v_revision integer;
BEGIN
  IF p_value IS NULL OR p_value = '' THEN RETURN; END IF;
  -- Serializa as revisões da mesma conversa, incluindo triggers e replay.
  PERFORM pg_advisory_xact_lock(hashtextextended('classification:' || p_env || ':' || p_conv_id, 0));
  SELECT * INTO v_previous FROM analytics.conversation_classifications
  WHERE environment=p_env::env_t AND conversation_id=p_conv_id AND dimension=p_dimension
    AND superseded_by IS NULL
  ORDER BY created_at DESC, revision DESC, id DESC LIMIT 1;
  IF v_previous.value = p_value AND v_previous.extractor_version = 'sql_v2_2026-09-16' THEN RETURN; END IF;
  SELECT COALESCE(max(revision),0)+1 INTO v_revision FROM analytics.conversation_classifications
  WHERE environment=p_env::env_t AND conversation_id=p_conv_id AND dimension=p_dimension;
  INSERT INTO analytics.conversation_classifications (
    environment,conversation_id,dimension,value,truth_type,source,confidence_level,
    extractor_version,ruleset_hash,revision,created_at
  ) VALUES (p_env::env_t,p_conv_id,p_dimension,p_value,'inferred','sql_rule_v2',1.00,
    'sql_v2_2026-09-16','sql_v2_2026-09-16',v_revision,clock_timestamp()) RETURNING id INTO v_id;
  UPDATE analytics.conversation_classifications SET superseded_by=v_id
  WHERE environment=p_env::env_t AND conversation_id=p_conv_id AND dimension=p_dimension
    AND superseded_by IS NULL AND id<>v_id;
END;
$fn$;

CREATE OR REPLACE FUNCTION analytics.extract_classifications_for_conv(p_conv_id uuid)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  v_env env_t;
  v_contact uuid;
  v_messages integer;
  v_had_order boolean;
  v_has_order boolean;
  v_cancelled boolean;
  v_handoff boolean;
  v_returning boolean;
  v_freight boolean;
  v_location boolean;
  v_quote boolean;
  v_price boolean;
  v_interest boolean;
  v_urgent boolean;
  v_expensive boolean;
  v_competitor boolean;
BEGIN
  SELECT environment,contact_id INTO v_env,v_contact FROM core.conversations WHERE id=p_conv_id;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('classification:' || v_env || ':' || p_conv_id, 0));
  SELECT count(*) INTO v_messages FROM core.messages
  WHERE environment=v_env AND conversation_id=p_conv_id AND deleted_at IS NULL AND NOT is_private;

  SELECT count(*)>0,
    COALESCE(bool_or(o.status<>'cancelled' AND (o.partner_order_id IS NULL OR
      (po.id IS NOT NULL AND po.status<>'cancelled' AND po.deleted_at IS NULL))),false)
  INTO v_had_order,v_has_order
  FROM commerce.orders o LEFT JOIN commerce.partner_orders po ON po.id=o.partner_order_id AND po.environment=o.environment
  WHERE o.environment=v_env AND o.source_conversation_id=p_conv_id;
  v_cancelled := v_had_order AND NOT v_has_order;
  v_returning := EXISTS (
    SELECT 1 FROM commerce.orders o
    LEFT JOIN commerce.partner_orders po ON po.id=o.partner_order_id AND po.environment=o.environment
    WHERE o.environment=v_env AND o.contact_id=v_contact AND o.source_conversation_id IS DISTINCT FROM p_conv_id
      AND o.status<>'cancelled' AND (o.partner_order_id IS NULL OR
        (po.id IS NOT NULL AND po.status<>'cancelled' AND po.deleted_at IS NULL))
  );
  v_handoff := EXISTS (
    SELECT 1 FROM agent.turns t,
      jsonb_array_elements(CASE WHEN jsonb_typeof(t.actions)='array' THEN t.actions ELSE '[]'::jsonb END) a,
      jsonb_array_elements(CASE WHEN jsonb_typeof(a->'tool_calls')='array' THEN a->'tool_calls' ELSE '[]'::jsonb END) tc
    WHERE t.environment=v_env AND t.conversation_id=p_conv_id AND t.status IN ('sent_api_ack','delivered')
      AND tc->'function'->>'name'='escalar_humano'
  );
  SELECT COALESCE(bool_or(fact_key='taxa_frete_cotada'),false),
    COALESCE(bool_or(fact_key='bairro_consultado'),false),
    COALESCE(bool_or(fact_key IN ('produto_cotado','preco_cotado')),false),
    COALESCE(bool_or(fact_key='preco_cotado'),false),
    COALESCE(bool_or(fact_key='moto_modelo_consultado'),false)
  INTO v_freight,v_location,v_quote,v_price,v_interest FROM analytics.conversation_facts
  WHERE environment=v_env AND conversation_id=p_conv_id AND superseded_by IS NULL;
  SELECT COALESCE(bool_or(hint_type='urgencia'),false),COALESCE(bool_or(hint_type='objecao_preco'),false),
    COALESCE(bool_or(hint_type='mencao_concorrente'),false)
  INTO v_urgent,v_expensive,v_competitor FROM analytics.linguistic_hints
  WHERE environment=v_env AND conversation_id=p_conv_id;

  PERFORM analytics._insert_classification(v_env::text,p_conv_id,'final_outcome',
    CASE WHEN v_has_order THEN 'fechou' WHEN v_cancelled THEN 'cancelado'
      WHEN v_handoff THEN 'escalou' WHEN v_messages<4 THEN 'desistiu_cedo' ELSE 'abandonou' END);
  PERFORM analytics._insert_classification(v_env::text,p_conv_id,'stage_reached',
    CASE WHEN v_had_order THEN 'pedido_criado' WHEN v_freight THEN 'frete_calculado'
      WHEN v_location THEN 'forneceu_bairro' WHEN v_quote THEN 'recebeu_cotacao'
      WHEN v_interest THEN 'mostrou_interesse' ELSE 'abriu_conversa' END);
  PERFORM analytics._insert_classification(v_env::text,p_conv_id,'customer_type',
    CASE WHEN v_returning THEN 'recorrente' ELSE 'novo' END);
  PERFORM analytics._insert_classification(v_env::text,p_conv_id,'buyer_intent',
    CASE WHEN v_has_order THEN 'comprou' WHEN v_cancelled THEN 'cancelou_pedido'
      WHEN v_location OR v_freight THEN 'pronto_pra_comprar'
      WHEN v_price THEN 'pesquisando_preco' ELSE 'duvida_geral' END);
  PERFORM analytics._insert_classification(v_env::text,p_conv_id,'urgency',
    CASE WHEN v_urgent THEN 'urgente' ELSE 'normal' END);
  -- A revisão sem perda retira um motivo antigo da view vigente, sem apagá-lo.
  PERFORM analytics._insert_classification(v_env::text,p_conv_id,'loss_reason',
    CASE WHEN v_has_order THEN 'nao_se_aplica' WHEN v_cancelled THEN 'pedido_cancelado'
      WHEN v_handoff THEN 'escalado_humano' WHEN v_expensive THEN 'objecao_preco'
      WHEN v_competitor THEN 'mencionou_concorrente' WHEN v_messages<4 THEN 'desistiu_cedo'
      WHEN v_freight THEN 'desistiu_apos_frete' WHEN v_location THEN 'desistiu_apos_bairro'
      ELSE 'abandonou_sem_motivo_claro' END);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'extract_classifications_for_conv %: %',p_conv_id,SQLERRM;
END;
$fn$;

-- Atualiza também cancelamentos feitos no painel, sem depender de outra fala do bot.
CREATE OR REPLACE FUNCTION analytics._trigger_order_classification()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE v_conv uuid;
BEGIN
  IF TG_TABLE_NAME='orders' THEN
    IF TG_OP='UPDATE' AND OLD.source_conversation_id IS DISTINCT FROM NEW.source_conversation_id
      AND OLD.source_conversation_id IS NOT NULL THEN
      PERFORM analytics.extract_classifications_for_conv(OLD.source_conversation_id);
    END IF;
    IF NEW.source_conversation_id IS NOT NULL THEN
      PERFORM analytics.extract_classifications_for_conv(NEW.source_conversation_id);
      PERFORM pg_notify('clientes_kanban',json_build_object('environment',NEW.environment,
        'conversation_id',NEW.source_conversation_id,'reason','order')::text);
    END IF;
  ELSE
    FOR v_conv IN SELECT DISTINCT source_conversation_id FROM commerce.orders
      WHERE environment=NEW.environment AND partner_order_id=NEW.id AND source_conversation_id IS NOT NULL
    LOOP
      PERFORM analytics.extract_classifications_for_conv(v_conv);
      PERFORM pg_notify('clientes_kanban',json_build_object('environment',NEW.environment,
        'conversation_id',v_conv,'reason','order')::text);
    END LOOP;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Analytics não pode impedir um cancelamento/estorno operacional.
  RAISE WARNING '_trigger_order_classification: %',SQLERRM;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS order_classification_changed ON commerce.orders;
CREATE TRIGGER order_classification_changed AFTER INSERT OR UPDATE OF status,source_conversation_id,partner_order_id
  ON commerce.orders FOR EACH ROW EXECUTE FUNCTION analytics._trigger_order_classification();
DROP TRIGGER IF EXISTS partner_order_classification_changed ON commerce.partner_orders;
CREATE TRIGGER partner_order_classification_changed AFTER UPDATE OF status,deleted_at
  ON commerce.partner_orders FOR EACH ROW EXECUTE FUNCTION analytics._trigger_order_classification();

-- Recupera somente conversas com cancelamento já registrado, em cada ambiente.
DO $fn$
DECLARE v_conv uuid;
BEGIN
  FOR v_conv IN SELECT DISTINCT o.source_conversation_id FROM commerce.orders o
    LEFT JOIN commerce.partner_orders po ON po.id=o.partner_order_id AND po.environment=o.environment
    WHERE o.source_conversation_id IS NOT NULL
      AND (o.status='cancelled' OR po.status='cancelled' OR po.deleted_at IS NOT NULL)
  LOOP
    PERFORM analytics.extract_classifications_for_conv(v_conv);
  END LOOP;
END;
$fn$;
COMMIT;

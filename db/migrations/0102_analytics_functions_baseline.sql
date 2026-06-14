-- ============================================================
-- 0102_analytics_functions_baseline.sql
-- BASELINE (idempotente, NÃO-destrutivo): versiona as funções + trigger do
-- GERADOR de analytics que viviam SÓ no banco (nunca foram pro repo).
-- Extraído de prod via pg_get_functiondef em 2026-06-14. CREATE OR REPLACE =
-- re-aplicar não muda comportamento.
--
-- O gerador: trigger 'analytics_extract_facts' AFTER INSERT em agent.turns ->
-- _trigger_extract_facts -> extract_facts_from_turn (30+ facts, source
-- tool_result_v2) + extract_classifications_for_conv + extract_linguistic_hints_for_conv.
-- Helpers de gravação: _insert_fact / _insert_classification / _insert_hint.
--
-- POR QUÊ: o cérebro do analytics estava sem backup/histórico no git. Este é o
-- ponto de partida pra (depois) adicionar campos novos (faltou_estoque, qual_loja).
-- Assinatura: Orquestrador (Claude Opus 4.8) — banco, 2026-06-14
-- ============================================================

-- função: analytics._insert_classification
CREATE OR REPLACE FUNCTION analytics._insert_classification(p_env text, p_conv_id uuid, p_dimension text, p_value text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF p_value IS NULL OR p_value = '' THEN RETURN; END IF;
  INSERT INTO analytics.conversation_classifications (
    environment, conversation_id, dimension, value, truth_type, source,
    confidence_level, extractor_version, ruleset_hash
  ) VALUES (
    p_env::env_t, p_conv_id, p_dimension, p_value, 'inferred', 'sql_rule_v1',
    1.00, 'sql_v1_2026-05-26', 'sql_v1_2026-05-26'
  );
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '_insert_classification % = %: %', p_dimension, p_value, SQLERRM;
END;
$function$
;

-- função: analytics._insert_fact
CREATE OR REPLACE FUNCTION analytics._insert_fact(p_environment text, p_conversation_id uuid, p_message_id uuid, p_observed_at timestamp with time zone, p_fact_key text, p_fact_value jsonb)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_fact_id uuid;
BEGIN
  IF p_fact_value IS NULL OR p_fact_value::text = 'null' OR p_fact_value::text = '""' THEN
    RETURN;
  END IF;

  INSERT INTO analytics.conversation_facts (
    environment, conversation_id, fact_key, fact_value,
    observed_at, message_id, truth_type, source,
    confidence_level, extractor_version, ruleset_hash
  ) VALUES (
    p_environment::env_t, p_conversation_id, p_fact_key, p_fact_value,
    p_observed_at, p_message_id, 'observed', 'tool_result_v2',
    1.00, 'sql_v1_2026-05-26', 'sql_v1_2026-05-26'
  )
  RETURNING id INTO v_fact_id;

  INSERT INTO analytics.fact_evidence (
    environment, fact_id, from_message_id, evidence_text,
    evidence_type, extractor_version
  ) VALUES (
    p_environment::env_t, v_fact_id, p_message_id,
    'tool_result:' || p_fact_key,
    'inferred',  -- corrigido (era 'tool_result' que violava check)
    'sql_v1_2026-05-26'
  );
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'analytics._insert_fact falhou para % = %: %', p_fact_key, p_fact_value, SQLERRM;
END;
$function$
;

-- função: analytics._insert_hint
CREATE OR REPLACE FUNCTION analytics._insert_hint(p_env text, p_conv_id uuid, p_msg_id uuid, p_hint_type text, p_matched text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO analytics.linguistic_hints (
    environment, conversation_id, message_id, hint_type, matched_text, pattern_id,
    truth_type, source, confidence_level, extractor_version, ruleset_hash
  ) VALUES (
    p_env::env_t, p_conv_id, p_msg_id, p_hint_type, p_matched, 'regex_v1_' || p_hint_type,
    'observed', 'regex_v1', 0.90, 'sql_v1_2026-05-26', 'sql_v1_2026-05-26'
  );
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '_insert_hint %: %', p_hint_type, SQLERRM;
END;
$function$
;

-- função: analytics.enforce_fact_evidence_immutability
CREATE OR REPLACE FUNCTION analytics.enforce_fact_evidence_immutability()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE v_allow_cascade TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'analytics.fact_evidence is append-only: UPDATE blocked (id=%).', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    BEGIN v_allow_cascade := current_setting('analytics.allow_evidence_cascade', true); EXCEPTION WHEN OTHERS THEN v_allow_cascade := NULL; END;
    IF v_allow_cascade IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'analytics.fact_evidence is append-only: DELETE direto bloqueado (id=%).', OLD.id USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  RETURN NEW;
END; $function$
;

-- função: analytics.extract_classifications_for_conv
CREATE OR REPLACE FUNCTION analytics.extract_classifications_for_conv(p_conv_id uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_env text;
  v_contact_id uuid;
  v_total_msgs int;
  v_duration_sec int;
  v_has_order boolean;
  v_has_handoff boolean;
  v_prev_orders int;
  v_max_stage text;
  v_has_frete_calc boolean;
  v_has_bairro boolean;
BEGIN
  SELECT c.environment::text, c.contact_id INTO v_env, v_contact_id
  FROM core.conversations c WHERE c.id = p_conv_id;
  IF NOT FOUND THEN RETURN; END IF;

  -- Apaga classifications anteriores
  DELETE FROM analytics.conversation_classifications
  WHERE conversation_id = p_conv_id AND extractor_version = 'sql_v1_2026-05-26';

  -- Calcula valores
  SELECT COUNT(*), EXTRACT(EPOCH FROM (MAX(sent_at)-MIN(sent_at)))::int
  INTO v_total_msgs, v_duration_sec
  FROM core.messages
  WHERE conversation_id = p_conv_id AND deleted_at IS NULL AND is_private = false;

  v_has_order := EXISTS(SELECT 1 FROM commerce.orders WHERE source_conversation_id = p_conv_id);
  v_has_handoff := EXISTS(
    SELECT 1 FROM agent.turns t, jsonb_array_elements(t.actions) a, jsonb_array_elements(a->'tool_calls') tc
    WHERE t.conversation_id = p_conv_id AND tc->'function'->>'name' = 'escalar_humano'
  );

  SELECT COUNT(*) INTO v_prev_orders
  FROM commerce.orders o
  WHERE o.contact_id = v_contact_id AND o.source_conversation_id IS DISTINCT FROM p_conv_id;

  v_has_frete_calc := EXISTS(
    SELECT 1 FROM analytics.conversation_facts
    WHERE conversation_id = p_conv_id AND fact_key = 'taxa_frete_cotada'
  );
  v_has_bairro := EXISTS(
    SELECT 1 FROM analytics.conversation_facts
    WHERE conversation_id = p_conv_id AND fact_key = 'bairro_consultado'
  );

  -- ━━━ final_outcome ━━━
  PERFORM analytics._insert_classification(v_env, p_conv_id, 'final_outcome',
    CASE WHEN v_has_order THEN 'fechou'
         WHEN v_has_handoff THEN 'escalou'
         WHEN v_total_msgs < 4 THEN 'desistiu_cedo'
         ELSE 'abandonou' END);

  -- ━━━ stage_reached (máxima etapa do funil) ━━━
  v_max_stage := CASE
    WHEN v_has_order THEN 'pedido_criado'
    WHEN v_has_frete_calc THEN 'frete_calculado'
    WHEN v_has_bairro THEN 'forneceu_bairro'
    WHEN EXISTS(SELECT 1 FROM analytics.conversation_facts WHERE conversation_id = p_conv_id AND fact_key IN ('produto_cotado', 'preco_cotado')) THEN 'recebeu_cotacao'
    WHEN EXISTS(SELECT 1 FROM analytics.conversation_facts WHERE conversation_id = p_conv_id AND fact_key = 'moto_modelo_consultado') THEN 'mostrou_interesse'
    ELSE 'abriu_conversa'
  END;
  PERFORM analytics._insert_classification(v_env, p_conv_id, 'stage_reached', v_max_stage);

  -- ━━━ customer_type ━━━
  PERFORM analytics._insert_classification(v_env, p_conv_id, 'customer_type',
    CASE WHEN v_prev_orders > 0 THEN 'recorrente' ELSE 'novo' END);

  -- ━━━ buyer_intent ━━━
  PERFORM analytics._insert_classification(v_env, p_conv_id, 'buyer_intent',
    CASE
      WHEN v_has_order THEN 'comprou'
      WHEN v_has_bairro OR v_has_frete_calc THEN 'pronto_pra_comprar'
      WHEN EXISTS(SELECT 1 FROM analytics.conversation_facts WHERE conversation_id = p_conv_id AND fact_key = 'preco_cotado') THEN 'pesquisando_preco'
      ELSE 'duvida_geral'
    END);

  -- ━━━ urgency (vindo de hints linguísticos) ━━━
  PERFORM analytics._insert_classification(v_env, p_conv_id, 'urgency',
    CASE WHEN EXISTS(
      SELECT 1 FROM analytics.linguistic_hints
      WHERE conversation_id = p_conv_id AND hint_type = 'urgencia'
    ) THEN 'urgente' ELSE 'normal' END);

  -- ━━━ loss_reason (só se não fechou) ━━━
  IF NOT v_has_order THEN
    PERFORM analytics._insert_classification(v_env, p_conv_id, 'loss_reason',
      CASE
        WHEN v_has_handoff THEN 'escalado_humano'
        WHEN EXISTS(SELECT 1 FROM analytics.linguistic_hints WHERE conversation_id = p_conv_id AND hint_type = 'objecao_preco') THEN 'objecao_preco'
        WHEN EXISTS(SELECT 1 FROM analytics.linguistic_hints WHERE conversation_id = p_conv_id AND hint_type = 'mencao_concorrente') THEN 'mencionou_concorrente'
        WHEN v_total_msgs < 4 THEN 'desistiu_cedo'
        WHEN v_has_frete_calc THEN 'desistiu_apos_frete'
        WHEN v_has_bairro THEN 'desistiu_apos_bairro'
        ELSE 'abandonou_sem_motivo_claro'
      END);
  END IF;

EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'extract_classifications_for_conv %: %', p_conv_id, SQLERRM;
END;
$function$
;

-- função: analytics.extract_facts_from_turn
CREATE OR REPLACE FUNCTION analytics.extract_facts_from_turn(p_turn_id uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_env text;
  v_conv_id uuid;
  v_trigger_msg_id uuid;
  v_created_at timestamptz;
  v_actions jsonb;
  v_action jsonb;
  v_call jsonb;
  v_tool_name text;
  v_args jsonb;
  v_result jsonb;
  v_call_id text;
  v_result_by_call_id jsonb := '{}'::jsonb;
  v_veiculo jsonb;
  v_produto jsonb;
BEGIN
  -- Carrega o turno
  SELECT t.environment::text, t.conversation_id, t.trigger_message_id, t.actions, t.created_at
  INTO v_env, v_conv_id, v_trigger_msg_id, v_actions, v_created_at
  FROM agent.turns t
  WHERE t.id = p_turn_id
    AND t.agent_version = 'v2'
    AND t.status = 'delivered';

  IF NOT FOUND THEN RETURN; END IF;
  IF v_actions IS NULL OR jsonb_typeof(v_actions) <> 'array' THEN RETURN; END IF;

  -- Idempotência: apaga facts deste extractor pra este turno
  DELETE FROM analytics.fact_evidence
  WHERE from_message_id = v_trigger_msg_id
    AND extractor_version = 'sql_v1_2026-05-26';

  DELETE FROM analytics.conversation_facts
  WHERE conversation_id = v_conv_id
    AND message_id = v_trigger_msg_id
    AND extractor_version = 'sql_v1_2026-05-26';

  -- Mapeia tool_call_id → result (results vêm em actions separadas com role='tool')
  FOR v_action IN SELECT * FROM jsonb_array_elements(v_actions)
  LOOP
    IF v_action->>'role' = 'tool' AND v_action ? 'tool_call_id' THEN
      v_result_by_call_id := v_result_by_call_id ||
        jsonb_build_object(v_action->>'tool_call_id', v_action->'content');
    END IF;
  END LOOP;

  -- Processa cada tool call
  FOR v_action IN SELECT * FROM jsonb_array_elements(v_actions)
  LOOP
    IF v_action->>'role' = 'assistant' AND v_action ? 'tool_calls' THEN
      FOR v_call IN SELECT * FROM jsonb_array_elements(v_action->'tool_calls')
      LOOP
        v_tool_name := v_call->'function'->>'name';
        v_call_id := v_call->>'id';

        BEGIN
          v_args := (v_call->'function'->>'arguments')::jsonb;
        EXCEPTION WHEN OTHERS THEN
          v_args := '{}'::jsonb;
        END;

        -- Result vem como string JSON, parseia
        BEGIN
          v_result := (v_result_by_call_id->>v_call_id)::jsonb;
        EXCEPTION WHEN OTHERS THEN
          v_result := NULL;
        END;

        -- ━━━ criar_pedido ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        IF v_tool_name = 'criar_pedido' THEN
          PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'nome_cliente', v_args->'nome_cliente');
          PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'forma_pagamento', v_args->'forma_pagamento');
          PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'modalidade_entrega', v_args->'modalidade');
          PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'endereco_entrega', v_args->'endereco_entrega');
          PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'valor_frete', v_args->'valor_frete');

          IF v_result IS NOT NULL AND (v_result->>'ok')::boolean = true THEN
            PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'pedido_numero', v_result->'order_number');
            PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'pedido_total', v_result->'total');
            PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'pedido_subtotal', v_result->'subtotal_itens');
            PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'pedido_criado', to_jsonb(true));
          END IF;

        -- ━━━ calcular_frete ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        ELSIF v_tool_name = 'calcular_frete' THEN
          PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'bairro_consultado', v_args->'bairro');

          IF v_result IS NOT NULL AND (v_result->>'encontrado')::boolean = true THEN
            PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'bairro_canonico', v_result->'bairro_canonico');
            PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'municipio_entrega', v_result->'municipio');
            PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'taxa_frete_cotada', v_result->'valor');
            PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'prazo_entrega_dias', v_result->'prazo_dias');
          END IF;

        -- ━━━ buscar_compatibilidade ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        ELSIF v_tool_name = 'buscar_compatibilidade' THEN
          PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'moto_modelo_consultado', v_args->'moto_modelo');
          IF v_args ? 'moto_ano' THEN
            PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'moto_ano', v_args->'moto_ano');
          END IF;

          IF v_result IS NOT NULL AND (v_result->>'encontrado')::boolean = true THEN
            PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'moto_encontrada', to_jsonb(true));
            -- Itera cada veículo retornado
            FOR v_veiculo IN SELECT * FROM jsonb_array_elements(COALESCE(v_result->'veiculos', '[]'::jsonb))
            LOOP
              PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'moto_marca', v_veiculo->'make');
              PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'moto_modelo_resolvido', v_veiculo->'model');
              IF v_veiculo ? 'displacement_cc' THEN
                PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'moto_cilindrada', v_veiculo->'displacement_cc');
              END IF;
              -- Itera produtos retornados
              FOR v_produto IN SELECT * FROM jsonb_array_elements(COALESCE(v_veiculo->'produtos', '[]'::jsonb))
              LOOP
                PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'produto_cotado', v_produto->'product_name');
                PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'preco_cotado', v_produto->'current_price');
                PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'medida_pneu', v_produto->'tire_size');
                PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'posicao_pneu', v_produto->'position');
                IF v_produto ? 'is_oem' THEN
                  PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'pneu_oem', v_produto->'is_oem');
                END IF;
              END LOOP;
            END LOOP;
          END IF;

        -- ━━━ buscar_produto ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        ELSIF v_tool_name = 'buscar_produto' THEN
          IF v_args ? 'medida_pneu' THEN
            PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'medida_consultada', v_args->'medida_pneu');
          END IF;
          IF v_args ? 'marca' THEN
            PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'marca_consultada', v_args->'marca');
          END IF;

        -- ━━━ escalar_humano ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        ELSIF v_tool_name = 'escalar_humano' THEN
          PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'escalou', to_jsonb(true));
          PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'motivo_escalacao', v_args->'motivo');

        -- ━━━ buscar_politica ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        ELSIF v_tool_name = 'buscar_politica' THEN
          PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'politicas_consultadas', v_args->'policy_keys');

        -- ━━━ consultar_pedido ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        ELSIF v_tool_name = 'consultar_pedido' THEN
          PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'consultou_pedido', to_jsonb(true));
          IF v_args ? 'order_number' THEN
            PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'pedido_consultado', v_args->'order_number');
          END IF;

        END IF;
      END LOOP;
    END IF;
  END LOOP;

EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'analytics.extract_facts_from_turn falhou para %: %', p_turn_id, SQLERRM;
END;
$function$
;

-- função: analytics.extract_linguistic_hints_for_conv
CREATE OR REPLACE FUNCTION analytics.extract_linguistic_hints_for_conv(p_conv_id uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_env text;
  v_msg RECORD;
  v_match text;
BEGIN
  SELECT c.environment::text INTO v_env FROM core.conversations c WHERE c.id = p_conv_id;
  IF NOT FOUND THEN RETURN; END IF;

  DELETE FROM analytics.linguistic_hints
  WHERE conversation_id = p_conv_id AND extractor_version = 'sql_v1_2026-05-26';

  FOR v_msg IN
    SELECT id, content
    FROM core.messages
    WHERE conversation_id = p_conv_id
      AND sender_type = 'contact'
      AND deleted_at IS NULL
      AND is_private = false
      AND content IS NOT NULL AND content <> ''
  LOOP
    -- Saudação informal
    v_match := (regexp_match(v_msg.content, '\m(meu amigo|amigo|cara|brother|chefe|chefia|parceiro|mano|fera)\M', 'i'))[1];
    IF v_match IS NOT NULL THEN
      PERFORM analytics._insert_hint(v_env, p_conv_id, v_msg.id, 'saudacao_informal', v_match);
    END IF;

    -- Aceite explícito
    v_match := (regexp_match(v_msg.content, '\m(top|show|fechou|fechado|pode ser|beleza|blz|manda|bora|pode trazer|esse serve|tá bom|ta bom|valeu)\M', 'i'))[1];
    IF v_match IS NOT NULL THEN
      PERFORM analytics._insert_hint(v_env, p_conv_id, v_msg.id, 'aceite_explicito', v_match);
    END IF;

    -- Objeção de preço
    v_match := (regexp_match(v_msg.content, '\m(caro|salgado|puxado|desconto|abaixa|baratin)\M', 'i'))[1];
    IF v_match IS NOT NULL THEN
      PERFORM analytics._insert_hint(v_env, p_conv_id, v_msg.id, 'objecao_preco', v_match);
    END IF;

    -- Urgência
    v_match := (regexp_match(v_msg.content, '(urgente|preciso hoje|preciso agora|to precisando|tô precisando|moto parada|sem moto|hoje mesmo)', 'i'))[1];
    IF v_match IS NOT NULL THEN
      PERFORM analytics._insert_hint(v_env, p_conv_id, v_msg.id, 'urgencia', v_match);
    END IF;

    -- Confusão/dúvida sobre dados
    v_match := (regexp_match(v_msg.content, '(não sei|nao sei|esqueci|não lembro|nao lembro|tô perdido|to perdido|não tenho certeza)', 'i'))[1];
    IF v_match IS NOT NULL THEN
      PERFORM analytics._insert_hint(v_env, p_conv_id, v_msg.id, 'confusao', v_match);
    END IF;

    -- Menção de concorrente
    v_match := (regexp_match(v_msg.content, '\m(shopee|mercado livre|magalu|amazon|olx|outro lugar|outra loja)\M', 'i'))[1];
    IF v_match IS NOT NULL THEN
      PERFORM analytics._insert_hint(v_env, p_conv_id, v_msg.id, 'mencao_concorrente', v_match);
    END IF;

    -- Pergunta sobre garantia
    v_match := (regexp_match(v_msg.content, '\m(garantia|garante|cobertura|cobertu)', 'i'))[1];
    IF v_match IS NOT NULL THEN
      PERFORM analytics._insert_hint(v_env, p_conv_id, v_msg.id, 'pergunta_garantia', v_match);
    END IF;

    -- Pergunta sobre parcelamento
    v_match := (regexp_match(v_msg.content, '\m(parcel|divid|fiado)', 'i'))[1];
    IF v_match IS NOT NULL THEN
      PERFORM analytics._insert_hint(v_env, p_conv_id, v_msg.id, 'pergunta_parcelamento', v_match);
    END IF;

    -- Pedir humano
    v_match := (regexp_match(v_msg.content, '(falar com (atendente|humano|gente|pessoa)|quero um humano|atendente de verdade)', 'i'))[1];
    IF v_match IS NOT NULL THEN
      PERFORM analytics._insert_hint(v_env, p_conv_id, v_msg.id, 'pediu_humano', v_match);
    END IF;

    -- Gíria positiva (pode duplicar com aceite, mas serve pra perfil de tom)
    v_match := (regexp_match(v_msg.content, '\m(maneiro|massa|demais|irado|sinistro|legal|bacana)\M', 'i'))[1];
    IF v_match IS NOT NULL THEN
      PERFORM analytics._insert_hint(v_env, p_conv_id, v_msg.id, 'giria_positiva', v_match);
    END IF;

  END LOOP;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'extract_linguistic_hints_for_conv %: %', p_conv_id, SQLERRM;
END;
$function$
;

-- função: analytics._trigger_extract_facts
CREATE OR REPLACE FUNCTION analytics._trigger_extract_facts()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.agent_version = 'v2' AND NEW.status = 'delivered' THEN
    PERFORM analytics.extract_facts_from_turn(NEW.id);
    PERFORM analytics.extract_linguistic_hints_for_conv(NEW.conversation_id);
    PERFORM analytics.extract_classifications_for_conv(NEW.conversation_id);
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'trigger analytics %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$function$
;

-- trigger no agent.turns (dispara a extração a cada turno do bot)
DROP TRIGGER IF EXISTS analytics_extract_facts ON agent.turns;
CREATE TRIGGER analytics_extract_facts AFTER INSERT ON agent.turns FOR EACH ROW EXECUTE FUNCTION analytics._trigger_extract_facts();

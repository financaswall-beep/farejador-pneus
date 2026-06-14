-- ============================================================
-- 0104_analytics_foto_distancia_instalacao.sql
-- Passo 2 (continuação, handoff 2026-06-14): + 3 sensores determinísticos do Nível 1.
-- Constrói SOBRE o 0103 (faltou_estoque continua).
--
--  extract_facts_from_turn (CREATE OR REPLACE — full):
--   • pediu_foto        (fact)  — bot chamou a tool 'pedir_foto' (cliente quis ver o pneu).
--   • distancia_loja_km (fact)  — 'localizacao_loja' devolveu distancia_km da loja indicada.
--   (mantém TODOS os carimbos do 0102 + faltou_estoque do 0103.)
--
--  extract_linguistic_hints_for_conv (CREATE OR REPLACE — full):
--   • pediu_instalacao  (hint)  — cliente falou de instalar/montar o pneu (não é tool nem
--                                 campo do pedido — o bot responde pelo prompt; é fala).
--
-- NÃO incluído de propósito: 'canal' (core.conversations.channel_type vem NULL em prod —
-- ingestão não preenche; sensor em coluna vazia é inútil) e 'qual_loja_atendeu' (derivável
-- de commerce.orders.unit_id; não vale duplicar num gatilho por-turno).
-- FAIL-SAFE (EXCEPTION->WARNING). Idempotente. NÃO precisa Deploy (é gatilho no banco).
-- Assinatura: Orquestrador (Claude Opus 4.8) — banco/analytics, 2026-06-14
-- ============================================================

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
  SELECT t.environment::text, t.conversation_id, t.trigger_message_id, t.actions, t.created_at
  INTO v_env, v_conv_id, v_trigger_msg_id, v_actions, v_created_at
  FROM agent.turns t
  WHERE t.id = p_turn_id
    AND t.agent_version = 'v2'
    AND t.status = 'delivered';

  IF NOT FOUND THEN RETURN; END IF;
  IF v_actions IS NULL OR jsonb_typeof(v_actions) <> 'array' THEN RETURN; END IF;

  DELETE FROM analytics.fact_evidence
  WHERE from_message_id = v_trigger_msg_id
    AND extractor_version = 'sql_v1_2026-05-26';

  DELETE FROM analytics.conversation_facts
  WHERE conversation_id = v_conv_id
    AND message_id = v_trigger_msg_id
    AND extractor_version = 'sql_v1_2026-05-26';

  FOR v_action IN SELECT * FROM jsonb_array_elements(v_actions)
  LOOP
    IF v_action->>'role' = 'tool' AND v_action ? 'tool_call_id' THEN
      v_result_by_call_id := v_result_by_call_id ||
        jsonb_build_object(v_action->>'tool_call_id', v_action->'content');
    END IF;
  END LOOP;

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

        BEGIN
          v_result := (v_result_by_call_id->>v_call_id)::jsonb;
        EXCEPTION WHEN OTHERS THEN
          v_result := NULL;
        END;

        -- criar_pedido
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

        -- calcular_frete
        ELSIF v_tool_name = 'calcular_frete' THEN
          PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'bairro_consultado', v_args->'bairro');

          IF v_result IS NOT NULL AND (v_result->>'encontrado')::boolean = true THEN
            PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'bairro_canonico', v_result->'bairro_canonico');
            PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'municipio_entrega', v_result->'municipio');
            PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'taxa_frete_cotada', v_result->'valor');
            PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'prazo_entrega_dias', v_result->'prazo_dias');
          END IF;

        -- buscar_compatibilidade
        ELSIF v_tool_name = 'buscar_compatibilidade' THEN
          PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'moto_modelo_consultado', v_args->'moto_modelo');
          IF v_args ? 'moto_ano' THEN
            PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'moto_ano', v_args->'moto_ano');
          END IF;

          IF v_result IS NOT NULL AND (v_result->>'encontrado')::boolean = true THEN
            PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'moto_encontrada', to_jsonb(true));
            FOR v_veiculo IN SELECT * FROM jsonb_array_elements(COALESCE(v_result->'veiculos', '[]'::jsonb))
            LOOP
              PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'moto_marca', v_veiculo->'make');
              PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'moto_modelo_resolvido', v_veiculo->'model');
              IF v_veiculo ? 'displacement_cc' THEN
                PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'moto_cilindrada', v_veiculo->'displacement_cc');
              END IF;
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

        -- buscar_produto (+ faltou_estoque, do 0103)
        ELSIF v_tool_name = 'buscar_produto' THEN
          IF v_args ? 'medida_pneu' THEN
            PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'medida_consultada', v_args->'medida_pneu');
          END IF;
          IF v_args ? 'marca' THEN
            PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'marca_consultada', v_args->'marca');
          END IF;
          IF v_result IS NOT NULL THEN
            IF (v_result->>'encontrado') = 'false' THEN
              PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'faltou_estoque',
                jsonb_strip_nulls(jsonb_build_object(
                  'motivo', 'fora_de_catalogo',
                  'medida', v_args->'medida_pneu',
                  'marca',  v_args->'marca',
                  'posicao', v_args->'posicao_pneu')));
            ELSIF (v_result->>'sem_estoque_loja_perto') = 'true' THEN
              PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'faltou_estoque',
                jsonb_strip_nulls(jsonb_build_object(
                  'motivo', 'sem_estoque_perto',
                  'medida', v_args->'medida_pneu',
                  'marca',  v_args->'marca',
                  'posicao', v_args->'posicao_pneu')));
            END IF;
          END IF;

        -- localizacao_loja (NOVO 0104: distância da loja indicada)
        ELSIF v_tool_name = 'localizacao_loja' THEN
          IF v_result IS NOT NULL AND v_result ? 'distancia_km' THEN
            PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'distancia_loja_km', v_result->'distancia_km');
          END IF;

        -- pedir_foto (NOVO 0104: cliente quis ver o pneu usado)
        ELSIF v_tool_name = 'pedir_foto' THEN
          PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'pediu_foto', to_jsonb(true));

        -- escalar_humano
        ELSIF v_tool_name = 'escalar_humano' THEN
          PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'escalou', to_jsonb(true));
          PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'motivo_escalacao', v_args->'motivo');

        -- buscar_politica
        ELSIF v_tool_name = 'buscar_politica' THEN
          PERFORM analytics._insert_fact(v_env, v_conv_id, v_trigger_msg_id, v_created_at, 'politicas_consultadas', v_args->'policy_keys');

        -- consultar_pedido
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
    v_match := (regexp_match(v_msg.content, '\m(meu amigo|amigo|cara|brother|chefe|chefia|parceiro|mano|fera)\M', 'i'))[1];
    IF v_match IS NOT NULL THEN
      PERFORM analytics._insert_hint(v_env, p_conv_id, v_msg.id, 'saudacao_informal', v_match);
    END IF;

    v_match := (regexp_match(v_msg.content, '\m(top|show|fechou|fechado|pode ser|beleza|blz|manda|bora|pode trazer|esse serve|tá bom|ta bom|valeu)\M', 'i'))[1];
    IF v_match IS NOT NULL THEN
      PERFORM analytics._insert_hint(v_env, p_conv_id, v_msg.id, 'aceite_explicito', v_match);
    END IF;

    v_match := (regexp_match(v_msg.content, '\m(caro|salgado|puxado|desconto|abaixa|baratin)\M', 'i'))[1];
    IF v_match IS NOT NULL THEN
      PERFORM analytics._insert_hint(v_env, p_conv_id, v_msg.id, 'objecao_preco', v_match);
    END IF;

    v_match := (regexp_match(v_msg.content, '(urgente|preciso hoje|preciso agora|to precisando|tô precisando|moto parada|sem moto|hoje mesmo)', 'i'))[1];
    IF v_match IS NOT NULL THEN
      PERFORM analytics._insert_hint(v_env, p_conv_id, v_msg.id, 'urgencia', v_match);
    END IF;

    v_match := (regexp_match(v_msg.content, '(não sei|nao sei|esqueci|não lembro|nao lembro|tô perdido|to perdido|não tenho certeza)', 'i'))[1];
    IF v_match IS NOT NULL THEN
      PERFORM analytics._insert_hint(v_env, p_conv_id, v_msg.id, 'confusao', v_match);
    END IF;

    v_match := (regexp_match(v_msg.content, '\m(shopee|mercado livre|magalu|amazon|olx|outro lugar|outra loja)\M', 'i'))[1];
    IF v_match IS NOT NULL THEN
      PERFORM analytics._insert_hint(v_env, p_conv_id, v_msg.id, 'mencao_concorrente', v_match);
    END IF;

    v_match := (regexp_match(v_msg.content, '\m(garantia|garante|cobertura|cobertu)', 'i'))[1];
    IF v_match IS NOT NULL THEN
      PERFORM analytics._insert_hint(v_env, p_conv_id, v_msg.id, 'pergunta_garantia', v_match);
    END IF;

    v_match := (regexp_match(v_msg.content, '\m(parcel|divid|fiado)', 'i'))[1];
    IF v_match IS NOT NULL THEN
      PERFORM analytics._insert_hint(v_env, p_conv_id, v_msg.id, 'pergunta_parcelamento', v_match);
    END IF;

    v_match := (regexp_match(v_msg.content, '(falar com (atendente|humano|gente|pessoa)|quero um humano|atendente de verdade)', 'i'))[1];
    IF v_match IS NOT NULL THEN
      PERFORM analytics._insert_hint(v_env, p_conv_id, v_msg.id, 'pediu_humano', v_match);
    END IF;

    v_match := (regexp_match(v_msg.content, '\m(maneiro|massa|demais|irado|sinistro|legal|bacana)\M', 'i'))[1];
    IF v_match IS NOT NULL THEN
      PERFORM analytics._insert_hint(v_env, p_conv_id, v_msg.id, 'giria_positiva', v_match);
    END IF;

    -- Pediu instalação / montagem (NOVO 0104): fala do cliente sobre instalar o pneu.
    -- Não é tool nem campo do pedido (o bot responde pelo prompt) — por isso é hint.
    v_match := (regexp_match(v_msg.content, '(instala|instalação|instalacao|montagem|mão de obra|mao de obra|coloca o pneu|botar o pneu|monta o pneu|montar o pneu)', 'i'))[1];
    IF v_match IS NOT NULL THEN
      PERFORM analytics._insert_hint(v_env, p_conv_id, v_msg.id, 'pediu_instalacao', v_match);
    END IF;

  END LOOP;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'extract_linguistic_hints_for_conv %: %', p_conv_id, SQLERRM;
END;
$function$
;

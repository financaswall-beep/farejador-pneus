-- ============================================================
-- 0103_analytics_faltou_estoque.sql
-- Passo 2 da inteligência (handoff 2026-06-14): adiciona o 1º carimbo novo na
-- extract_facts_from_turn — 'faltou_estoque' (DEMANDA REPRIMIDA): o que o cliente
-- pediu e a Rede NÃO pôde dar. É a matéria-prima da "lista de compras do atacado"
-- (frente futura: matriz). Dado que NÃO existe em nenhum outro lugar hoje.
--
-- Fonte: o RESULT do buscar_produto (que a função ainda não lia — só lia os args):
--   • encontrado=false           -> motivo 'fora_de_catalogo'  (não tem NEM no catálogo)
--   • sem_estoque_loja_perto=true -> motivo 'sem_estoque_perto' (tem no catálogo, mas
--                                     nenhuma loja perto do cliente tinha)
-- fact_value (jsonb): { motivo, medida, marca, posicao } (jsonb_strip_nulls).
--
-- CREATE OR REPLACE de UMA função só (as demais funções/trigger do 0102 ficam iguais).
-- FAIL-SAFE: o corpo inteiro já é envolvido por EXCEPTION->WARNING; erro na extração
-- NUNCA derruba o bot. Idempotente (re-aplicar não muda comportamento).
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
          -- NOVO (0103): demanda reprimida / faltou_estoque — o que o cliente pediu e a
          -- Rede não pôde dar. 'fora_de_catalogo' = busca não achou NADA; 'sem_estoque_perto'
          -- = existe no catálogo, mas nenhuma loja perto do cliente tinha.
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

/**
 * Prompt do Generator Shadow — Sprint 6.5 (Caminho B, v1.1.0).
 *
 * Mudança em relação ao v1.0.0: actions vêm em formato CRU (sem campos meta).
 * O código hidrata action_id, turn_index, emitted_at, emitted_by depois.
 *
 * Regras absolutas incorporadas no system prompt:
 * - Nunca inventar preço, estoque, frete ou compatibilidade.
 * - Se faltar dado, usar fallback seguro.
 * - Nunca criar pedido nem enviar mensagem ao Chatwoot.
 */

import type { OpenAIMessage } from '../../shared/llm-clients/openai.js';
import type { PlannerContext } from '../planner/context-builder.js';
import type { PlannerDecisionResult } from '../planner/service.js';
import type { ToolExecutionResult } from '../executor/tool-executor.js';
import { generatorPromptVersion, SAFE_FALLBACK_SAY } from './schemas.js';

export function buildGeneratorMessages(
  context: PlannerContext,
  decision: PlannerDecisionResult,
  toolResults: ToolExecutionResult[],
): OpenAIMessage[] {
  return [
    {
      role: 'system',
      content: [
        `prompt_version=${generatorPromptVersion}`,
        'Voce e o Generator da Atendente do Farejador.',
        'Sua funcao e redigir a resposta final ao cliente com base nos dados fornecidos.',
        '',
        'REGRAS ABSOLUTAS — nunca violar:',
        '1. NAO invente preco. Use apenas valores presentes em tool_results.',
        '2. NAO invente estoque. Use apenas dados de tool_results.',
        '3. NAO invente frete. Use apenas dados de tool_results.',
        '4. NAO invente compatibilidade. Use apenas dados de tool_results.',
        `5. Se faltar dado operacional, responda exatamente: "${SAFE_FALLBACK_SAY}"`,
        '6. NAO crie pedido. NAO envie mensagem ao Chatwoot.',
        '7. Voce so pode emitir quatro tipos de action: update_slot, create_item, record_offer, update_draft.',
        '   Outras actions (add_to_cart, escalate, request_confirmation, etc) nao sao aceitas neste turno.',
        '8. Memoria operacional e sua responsabilidade neste turno: se o cliente informou dado novo, emita action.',
        '',
        'FORMATO DE SAIDA — JSON estrito:',
        '{ "say": string, "actions": RawAction[], "rationale": string, "prompt_version": string }',
        '',
        'CADA RawAction segue UM dos formatos abaixo (sem campos meta — o codigo preenche):',
        '',
        '— update_slot —',
        '{',
        '  "type": "update_slot",',
        '  "scope": "global" | "item",',
        '  "item_id": "<uuid>" | null,        // null se scope=global',
        '  "slot_key": "<chave da whitelist>", // ex: moto_modelo, medida_pneu, bairro',
        '  "value": <valor compativel com a chave>,',
        '  "source": "observed" | "inferred" | "confirmed" | "offered_to_client" |',
        '            "inferred_from_history" | "inferred_from_organizadora",',
        '  "confidence": <numero entre 0 e 1>,',
        '  "evidence_text": "<trecho literal da mensagem do cliente>" | null,',
        '  "set_by_message_id": "<uuid da mensagem do cliente>" | null',
        '}',
        '',
        '— create_item —',
        '{ "type": "create_item", "item_id": "<uuid>", "make_active": true }',
        '',
        '— record_offer —',
        '{',
        '  "type": "record_offer",',
        '  "offer_id": "<uuid>",',
        '  "item_id": "<uuid de session_items existente>",',
        '  "products": [ { ...campos do produto retornado por buscarProduto... } ],',
        '  "expires_at": "<ISO datetime>"',
        '}',
        '',
        '— update_draft —',
        '{',
        '  "type": "update_draft",',
        '  "customer_name": "<nome do cliente>"?,',
        '  "delivery_address": "<endereco de entrega>"?,',
        '  "fulfillment_mode": "delivery" | "pickup"?,',
        '  "payment_method": "pix" | "cartao_credito" | "cartao_debito" | "dinheiro" | "boleto"?',
        '}',
        '',
        'Whitelist de slot_key:',
        '  global: nome, bairro, municipio, forma_pagamento',
        '  item: moto_modelo, moto_ano, moto_cilindrada, medida_pneu, posicao_pneu,',
        '        quantidade, marca_preferida, marca_recusada, faixa_preco_max',
        '',
        'REGRAS DE MEMORIA EM TEMPO REAL:',
        '- Para cada dado novo dito pelo cliente na mensagem atual, emita update_slot mesmo que voce ainda nao consiga ofertar.',
        '- Dados globais (nome, bairro, municipio, forma_pagamento) usam scope="global" e item_id=null.',
        '- Dados de produto/pneu/moto usam scope="item" e item_id do item correspondente.',
        '- Se o cliente citar uma medida/produto novo sem item correspondente, emita create_item antes dos update_slot desse item.',
        '- Se o cliente citar dois pneus/produtos na mesma mensagem, crie/atualize dois itens separados; nao misture medidas no mesmo item.',
        '- Reuse item existente quando a mensagem claramente complementa o mesmo produto ativo.',
        '- Use source="observed" para dado literal da mensagem do cliente; confidence >= 0.9 quando o dado estiver explicito.',
        '- Use evidence_text com o trecho exato que justifica o slot.',
        '- Use set_by_message_id com o id da mensagem customer mais recente quando disponivel.',
        '- Nao grave como slot uma suposicao comercial sua; se for inferencia fraca, deixe sem action ou use unsupported_observation (quando habilitado).',
        '- Para endereco completo, use update_draft.delivery_address; para bairro/municipio extraidos do endereco, tambem use update_slot global.',
        '- Para pagamento mencionado, use update_draft.payment_method e update_slot global forma_pagamento.',
        '',
        'EXEMPLO DE RACIOCINIO (nao copie literalmente):',
        'Cliente: "quero um 140/70-17 e outro 110/70-17, entrega no Centro, pago no cartao"',
        'Acoes esperadas: create_item item A + update_slot medida_pneu=140/70-17; create_item item B + update_slot medida_pneu=110/70-17; update_slot bairro=Centro; update_slot forma_pagamento=cartao_credito; update_draft payment_method=cartao_credito.',
        '',
        'Regras finais:',
        '- say: max 2000 chars, resposta direta ao cliente.',
        '- actions: array (pode ser []). Sempre que observar fato novo do cliente, emita update_slot; nao espere a conversa encerrar.',
        '- rationale: max 500 chars, justificativa interna nao enviada ao cliente.',
        `- prompt_version: exatamente "${generatorPromptVersion}".`,
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        context: {
          environment: context.environment,
          conversation_id: context.conversation_id,
          state_summary: {
            status: context.state.status,
            current_skill: context.state.current_skill,
            turn_index: context.state.turn_index,
            global_slots: context.state.global_slots,
            order_draft: context.state.order_draft ?? null,
            cart: context.state.cart,
            items: context.state.items,
            active_item: context.state.items.find((item) => item.is_active) ?? null,
            items_count: context.state.items.length,
          },
          recent_messages: context.recent_messages,
          recent_tool_results: context.recent_tool_results,
          organizer_facts: context.organizer_facts,
          derived_signals: context.derived_signals,
        },
        planner_decision: {
          skill: decision.output.skill,
          missing_slots: decision.output.missing_slots,
          risk_flags: decision.output.risk_flags,
          confidence: decision.output.confidence,
          rationale: decision.output.rationale,
        },
        tool_results: toolResults.map((result) => ({
          tool: result.tool,
          ok: result.ok,
          output: result.output,
          error_message: result.error_message,
        })),
        output_contract: {
          say: 'resposta para o cliente, max 2000 chars',
          actions: 'array de RawAction (pode ser [])',
          rationale: 'justificativa interna, max 500 chars',
          prompt_version: generatorPromptVersion,
        },
      }),
    },
  ];
}

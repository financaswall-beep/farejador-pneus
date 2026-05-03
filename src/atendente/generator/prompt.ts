/**
 * Prompt do Generator Shadow — Sprint 6.
 *
 * O Generator recebe contexto + decisão do Planner + resultados das tools
 * e redige a resposta final ao cliente.
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
        '7. Actions podem conter update_slot, create_item, record_offer — nunca add_to_cart sem confirmacao explicita do cliente.',
        '',
        'FORMATO DE SAIDA — JSON estrito:',
        '{ "say": string, "actions": AgentAction[], "rationale": string, "prompt_version": string }',
        'say: resposta direta ao cliente (max 2000 chars)',
        'actions: array de AgentAction validadas pelo schema (pode ser vazio [])',
        'rationale: justificativa interna max 500 chars (nao enviada ao cliente)',
        `prompt_version: exatamente "${generatorPromptVersion}"`,
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
            active_item: context.state.items.find((item) => item.is_active) ?? null,
            items_count: context.state.items.length,
          },
          recent_messages: context.recent_messages,
          recent_tool_results: context.recent_tool_results,
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
          actions: 'array de AgentAction (pode ser [])',
          rationale: 'justificativa interna, max 500 chars',
          prompt_version: generatorPromptVersion,
        },
      }),
    },
  ];
}

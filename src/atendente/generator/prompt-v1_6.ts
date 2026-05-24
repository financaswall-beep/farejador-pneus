/**
 * Builder do Generator v1.6 (Modular) — 2026-05-24.
 *
 * Diferenca vs v1.5 (monolitico):
 *   v1.5: 1 mega-prompt com 20 exemplos pra TODAS skills, ~5.144 tokens
 *   v1.6: 1 prompt-common (1.500-1.800 tok) + 1 arquivo de exemplos por skill (~600-1.200 tok cada)
 *
 * Resultado por chamada:
 *   - Skill com mais exemplos (registrar_intencao_fechamento, 9 exs) → ~3.000 tokens
 *   - Skill com menos exemplos (escalar_humano, 1 ex) → ~1.800 tokens
 *   - Media esperada: ~2.500 tokens (vs 5.144 do v1.5) = ~50% reducao
 *
 * Roteamento: olha decision.output.skill e escolhe o arquivo de exemplos.
 * Skill desconhecida → cai em buscar_e_ofertar (default seguro).
 *
 * API mantida igual ao v1.5 — caller pode trocar buildGeneratorMessagesFewShot
 * por buildGeneratorMessagesModular sem mudar mais nada.
 */

import type { OpenAIMessage } from '../../shared/llm-clients/openai.js';
import type { PlannerContext } from '../planner/context-builder.js';
import type { PlannerDecisionResult } from '../planner/service.js';
import type { ToolExecutionResult } from '../executor/tool-executor.js';
import { type GeneratorRetryContext } from './schemas.js';
import { buildGeneratorContextPayload } from './prompt.js';
import { COMMON_BLOCK, generatorPromptVersionV16 } from './prompts-v1_6/common.js';
import { SKILL_BUSCAR_E_OFERTAR_EXAMPLES } from './prompts-v1_6/skill-buscar-e-ofertar.js';
import { SKILL_REGISTRAR_INTENCAO_FECHAMENTO_EXAMPLES } from './prompts-v1_6/skill-registrar-intencao-fechamento.js';
import { SKILL_RESPONDER_LOGISTICA_EXAMPLES } from './prompts-v1_6/skill-responder-logistica.js';
import { SKILL_PEDIR_DADOS_FALTANTES_EXAMPLES } from './prompts-v1_6/skill-pedir-dados-faltantes.js';
import { SKILL_TRATAR_OBJECAO_EXAMPLES } from './prompts-v1_6/skill-tratar-objecao.js';
import { SKILL_RESPONDER_GERAL_EXAMPLES } from './prompts-v1_6/skill-responder-geral.js';
import { SKILL_ESCALAR_HUMANO_EXAMPLES } from './prompts-v1_6/skill-escalar-humano.js';

const SKILL_EXAMPLES_MAP: Record<string, string> = {
  buscar_e_ofertar: SKILL_BUSCAR_E_OFERTAR_EXAMPLES,
  registrar_intencao_fechamento: SKILL_REGISTRAR_INTENCAO_FECHAMENTO_EXAMPLES,
  responder_logistica: SKILL_RESPONDER_LOGISTICA_EXAMPLES,
  pedir_dados_faltantes: SKILL_PEDIR_DADOS_FALTANTES_EXAMPLES,
  tratar_objecao: SKILL_TRATAR_OBJECAO_EXAMPLES,
  responder_geral: SKILL_RESPONDER_GERAL_EXAMPLES,
  escalar_humano: SKILL_ESCALAR_HUMANO_EXAMPLES,
};

/**
 * Resolve qual bloco de exemplos enviar pra esta chamada.
 * Skill desconhecida ou null → default seguro (buscar_e_ofertar, mais usada).
 */
export function selectExamplesForSkill(skill: string | null | undefined): string {
  if (!skill) return SKILL_BUSCAR_E_OFERTAR_EXAMPLES;
  return SKILL_EXAMPLES_MAP[skill] ?? SKILL_BUSCAR_E_OFERTAR_EXAMPLES;
}

export function buildGeneratorMessagesModular(
  context: PlannerContext,
  decision: PlannerDecisionResult,
  toolResults: ToolExecutionResult[],
  retryContext?: GeneratorRetryContext,
): OpenAIMessage[] {
  const skill = decision.output.skill;
  const examplesBlock = selectExamplesForSkill(skill);

  const systemPrompt = [COMMON_BLOCK, '', examplesBlock].join('\n');

  const messages: OpenAIMessage[] = [
    {
      role: 'system',
      content: systemPrompt,
    },
    {
      role: 'user',
      content: JSON.stringify(buildGeneratorContextPayload(context, decision, toolResults, generatorPromptVersionV16)),
    },
  ];

  if (retryContext) {
    messages.push({
      role: 'system',
      content: buildRetryInstruction(retryContext, decision.output.skill),
    });
  }

  return messages;
}

function buildRetryInstruction(retry: GeneratorRetryContext, skill: string): string {
  if (retry.reason === 'previous_blocked') {
    return [
      '# RETRY — sua resposta anterior foi BLOQUEADA pelo validator.',
      '',
      `motivo: ${retry.previous_block_reason ?? 'unknown'}`,
      retry.previous_candidate_say ? `say bloqueado: "${retry.previous_candidate_say}"` : '',
      '',
      'COMO REESCREVER:',
      '- claim_invalid:price → voce tentou afirmar preço sem evidência de buscarProduto. Não cite valor.',
      '- claim_invalid:delivery_fee → voce tentou afirmar frete sem evidência de calcularFrete. Pergunte bairro/CEP ao cliente.',
      '- claim_invalid:fitment → voce afirmou compatibilidade sem evidência de buscarCompatibilidade. Pergunte ano/medida.',
      '- claim_invalid:stock → voce afirmou estoque sem verificarEstoque. Não diga "em estoque".',
      '- action_blocked → ajuste a action conforme o motivo. Hidratação inválida geralmente eh referência a item_id que nao existe.',
      '',
      `Mantenha skill=${skill}, mantenha slots já registrados, mude apenas o que causou o bloqueio.`,
      'NAO use a frase de SAFE_FALLBACK_SAY a menos que realmente nao haja saida.',
    ].filter(Boolean).join('\n');
  }

  // previous_fallback
  return [
    '# RETRY — sua resposta anterior foi a FRASE DE FALLBACK ("Desculpe...").',
    '',
    retry.previous_say ? `say anterior: "${retry.previous_say}"` : '',
    '',
    'Fallback eh ULTIMA opcao. Reveja com calma:',
    `- Skill recebida = ${skill}.`,
    '- Voce TEM state.global_slots e state.items com dados ja preenchidos de turnos anteriores.',
    '- Casos onde fallback eh ERRADO:',
    '  * Cliente confirmando aritmetica sobre valores ja cotados ("198 + 9,90, ok?") → confirma a soma.',
    '  * Cliente sinalizou fechamento ("vou querer", "fecha", "pode mandar") → peça nome/endereco/pagamento.',
    '  * Cliente despedindo ("valeu", "obrigado", "blz amigo") → responda com cordialidade.',
    '  * Cliente fazendo pergunta sobre algo que esta em state.global_slots/state.items → responda do estado.',
    '',
    'REESCREVA uma resposta que AVANCE a conversa. Use o contexto que voce tem.',
  ].filter(Boolean).join('\n');
}

// Re-export utilitarios pra caller poder importar de um lugar so
export { generatorPromptVersionV16 } from './prompts-v1_6/common.js';
export { SKILL_EXAMPLES_MAP };

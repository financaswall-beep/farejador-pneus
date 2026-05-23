/**
 * Generator Shadow — Sprint 6 + Sprint 6.5 (Caminho B).
 *
 * Responsabilidades:
 * - Gerar resposta candidata auditável a partir de contexto + plano + tools.
 * - Validar com SayValidator e ActionValidator antes de registrar.
 * - Hidratar actions cruas com meta-campos (action_id, turn_index, emitted_at, emitted_by).
 * - Gravar resultado em agent.turns (status='generated'|'blocked') e
 *   audit em agent.session_events (event_type='generator_produced').
 * - NUNCA enviar mensagem ao Chatwoot.
 * - NUNCA escrever em raw.*, core.*, analytics.* ou commerce.*.
 *
 * Hierarquia de dados (maior procedência prevalece):
 *   confirmed > observed > tool/sistema > inferred_from_organizadora > histórico
 */

import type { PoolClient } from 'pg';
import { env } from '../../shared/config/env.js';
import { deterministicUuid } from '../../shared/deterministic-id.js';
import { callOpenAIResponse, type OpenAICallResult } from '../../shared/llm-clients/openai.js';
import { logger } from '../../shared/logger.js';
import type { AgentAction } from '../../shared/zod/agent-actions.js';
import type { PlannerContext } from '../planner/context-builder.js';
import type { SkillName } from '../planner/schemas.js';
import type { PlannerDecisionResult } from '../planner/service.js';
import type { ToolExecutionResult } from '../executor/tool-executor.js';
import { validateSay } from '../validators/say-validator.js';
import { validateAction } from '../validators/action-validator.js';
import { validateClaims } from '../validators/claim-validator.js';
import type { ToolResultForValidation } from '../validators/tool-results.js';
import { buildGeneratorMessages } from './prompt.js';
import { buildGeneratorMessagesFewShot } from './prompt-v1_5.js';
import {
  generatorOutputJsonSchema,
  generatorOutputRawSchema,
  generatorPromptVersion,
  generatorPromptVersionV14,
  generatorPromptVersionV15,
  generatorAgentVersion,
  hydrateGeneratorActions,
  SAFE_FALLBACK_SAY,
  type GeneratorClaim,
  type GeneratorRawAction,
  type GeneratorResult,
  type GeneratorRetryContext,
} from './schemas.js';

/**
 * Versao do prompt que ESTA ativa neste processo (gated por env flag).
 * Usada como fallback quando o caminho LLM nao chegou a parsear output
 * (mock, fallback de erro). No caminho LLM bem-sucedido, a versao real
 * que o modelo emitiu eh preferida — vinda de parsed.data.prompt_version.
 */
function activeGeneratorPromptVersion(): string {
  return env.GENERATOR_PROMPT_FEW_SHOT_ENABLED
    ? generatorPromptVersionV15
    : generatorPromptVersionV14;
}

// ------------------------------------------------------------------
// Validação
// ------------------------------------------------------------------

function toValidationCtx(
  toolResults: ToolExecutionResult[],
  context: PlannerContext,
  selectedSkill?: SkillName,
): {
  recent_tool_results: ToolResultForValidation[];
  tool_results_history: ToolResultForValidation[];
  selected_skill?: string;
} {
  return {
    recent_tool_results: toolResults.map((result) => ({
      tool: result.tool,
      ok: result.ok,
      output: result.output,
    })),
    // History de turns passados, com output cru pra o validator olhar
    // money/preco/frete ja cotados. Sem isso, perguntas do tipo "quanto deu
    // tudo?" depois de cotacao em turnos anteriores caem em
    // money_mentioned_without_tool_result.
    tool_results_history: context.recent_tool_results
      .filter((r): r is typeof r & { output_raw: unknown } => r.output_raw !== undefined)
      .map((r) => ({
        tool: r.tool,
        ok: r.ok,
        output: r.output_raw,
      })),
    selected_skill: selectedSkill,
  };
}

function runValidators(
  say: string,
  actions: AgentAction[],
  claims: GeneratorClaim[],
  toolResults: ToolExecutionResult[],
  context: PlannerContext,
  selectedSkill?: SkillName,
): { blocked: boolean; block_reason: string | null } {
  const sayCtx = toValidationCtx(toolResults, context, selectedSkill);

  // Etapa 2: claims-first validation. Se Generator emitiu claims sem evidencia,
  // bloqueia antes do say-validator (mais especifico, melhor reason). Quando
  // claims=[] (legado/turn sem afirmacao comercial), passa direto.
  const claimResult = validateClaims(claims, sayCtx.recent_tool_results);
  if (!claimResult.valid) {
    return { blocked: true, block_reason: claimResult.reason };
  }

  // Say-validator regex permanece como rede de seguranca durante migracao
  // dos claims. Quando claim catalog cobrir todos os casos, considera retirar.
  const sayResult = validateSay(say, sayCtx);
  if (!sayResult.valid) {
    return { blocked: true, block_reason: sayResult.reason };
  }

  // The action validator checks each action against `context.state` without
  // mutating between iterations. To avoid `item_not_found` on a `record_offer`
  // (or `set_active_item` / `update_item_status`) that references an item
  // freshly created in the same array, we collect every `create_item.item_id`
  // up front and let the validator treat those as if they already existed.
  const incomingItemIds = new Set(
    actions
      .filter((action): action is Extract<AgentAction, { type: 'create_item' }> => action.type === 'create_item')
      .map((action) => action.item_id),
  );

  const actionCtx = { ...sayCtx, incoming_item_ids: incomingItemIds };

  for (const action of actions) {
    const actionResult = validateAction(context.state, action, actionCtx);
    if (!actionResult.valid) {
      return { blocked: true, block_reason: `action_blocked:${actionResult.reason}` };
    }
  }

  return { blocked: false, block_reason: null };
}

// ------------------------------------------------------------------
// Caminho mock (LLM desligado)
// ------------------------------------------------------------------

function mockGenerateTurn(
  context: PlannerContext,
  decision: PlannerDecisionResult,
  toolResults: ToolExecutionResult[],
): GeneratorResult {
  const skill = decision.output.skill;
  // Sprint 6.5 fix do A-3: tool result é "útil" só se ok=true E output não-vazio.
  const hasUsefulToolResults = toolResults.some(
    (result) => result.ok && hasNonEmptyOutput(result.output),
  );
  const missing = decision.output.missing_slots;

  let say: string;
  const actions: AgentAction[] = [];

  switch (skill) {
    case 'escalar_humano':
      say = 'Vou transferir você para um atendente humano agora.';
      break;
    case 'pedir_dados_faltantes':
      say =
        missing.length > 0
          ? `Para te ajudar melhor, preciso de mais informações: ${missing.join(', ')}.`
          : 'Poderia me fornecer mais detalhes?';
      break;
    case 'buscar_e_ofertar':
      // Sem tool results úteis → não posso ofertar nada com lastro
      say = hasUsefulToolResults
        ? 'Encontrei algumas opções para você. Posso detalhar mais?'
        : SAFE_FALLBACK_SAY;
      break;
    case 'responder_logistica':
      // Sem calcularFrete → não posso prometer frete
      say = hasUsefulToolResults
        ? 'Aqui estão as informações de entrega disponíveis.'
        : SAFE_FALLBACK_SAY;
      break;
    case 'tratar_objecao':
      say = 'Entendo sua preocupação. Posso esclarecer melhor?';
      break;
    case 'registrar_intencao_fechamento':
      say = 'Ótimo! Para finalizarmos, vou encaminhar para um atendente confirmar os detalhes.';
      break;
    default:
      say = 'Como posso te ajudar?';
  }

  // Mock generator nao emite claims — passa [] (sem afirmacoes a validar).
  const validation = runValidators(say, actions, [], toolResults, context, skill);
  const usedSafeFallback = say === SAFE_FALLBACK_SAY;

  return {
    say_text: validation.blocked ? null : say,
    actions: validation.blocked ? [] : actions,
    claims: [],
    prompt_version: activeGeneratorPromptVersion(),
    blocked: validation.blocked,
    block_reason: validation.block_reason,
    candidate_say_text: validation.blocked ? say : null,
    candidate_actions: validation.blocked ? actions : [],
    used_llm: false,
    fallback_used: usedSafeFallback,
    input_tokens: 0,
    output_tokens: 0,
    duration_ms: 0,
  };
}

function hasNonEmptyOutput(output: unknown): boolean {
  if (output === null || output === undefined) return false;
  if (Array.isArray(output)) return output.length > 0;
  if (typeof output === 'object') return Object.keys(output as Record<string, unknown>).length > 0;
  return true;
}

// ------------------------------------------------------------------
// Caminho fallback (erro ou falta de chave)
// ------------------------------------------------------------------

function fallbackResult(reason: string): GeneratorResult {
  return {
    say_text: null,
    actions: [],
    claims: [],
    prompt_version: activeGeneratorPromptVersion(),
    blocked: true,
    block_reason: reason,
    candidate_say_text: null,
    candidate_actions: [],
    used_llm: false,
    fallback_used: true,
    input_tokens: 0,
    output_tokens: 0,
    duration_ms: 0,
  };
}

// ------------------------------------------------------------------
// Entrada principal
// ------------------------------------------------------------------

/**
 * Gera resposta candidata auditável.
 * Nunca envia ao Chatwoot; nunca escreve em raw/core/analytics/commerce.
 *
 * Sprint 6.5: o LLM devolve actions cruas; aqui hidratamos antes de validar
 * para que campos meta nunca virem block_reason.
 */
export async function generateTurn(
  context: PlannerContext,
  decision: PlannerDecisionResult,
  toolResults: ToolExecutionResult[],
  retryContext?: GeneratorRetryContext,
): Promise<GeneratorResult> {
  if (!env.GENERATOR_LLM_ENABLED) {
    return mockGenerateTurn(context, decision, toolResults);
  }

  if (!env.GENERATOR_OPENAI_API_KEY) {
    logger.warn(
      { conversation_id: context.conversation_id },
      'generator: GENERATOR_LLM_ENABLED sem GENERATOR_OPENAI_API_KEY — usando fallback',
    );
    return fallbackResult('generator_llm_enabled_without_key');
  }

  const startedAt = Date.now();
  let llmResult: OpenAICallResult | undefined;

  try {
    // Etapa 5 (v1.5.0): feature flag escolhe entre prompt declarativo
    // (v1.4.0, ~3700 tokens) e prompt few-shot (v1.5.0, ~1700 tokens, 10
    // exemplos). Rodada A/B em catalog15-rerun antes de retirar v1.4.0.
    const messages = env.GENERATOR_PROMPT_FEW_SHOT_ENABLED
      ? buildGeneratorMessagesFewShot(context, decision, toolResults, retryContext)
      : buildGeneratorMessages(context, decision, toolResults, retryContext);
    llmResult = await callOpenAIResponse({
      apiKey: env.GENERATOR_OPENAI_API_KEY,
      model: env.GENERATOR_MODEL,
      messages,
      timeoutMs: env.OPENAI_TIMEOUT_MS,
      maxTokens: 1500,
      temperature: temperatureForModel(env.GENERATOR_MODEL),
      jsonSchema: {
        name: 'generator_output',
        schema: generatorOutputJsonSchema,
        strict: true,
      },
    });

    const parsed = generatorOutputRawSchema.safeParse(JSON.parse(llmResult.content));
    if (!parsed.success) {
      logger.warn(
        { conversation_id: context.conversation_id, error: parsed.error.message },
        'generator: schema validation failed — usando fallback',
      );
      return {
        ...fallbackResult(`generator_schema_failed:${parsed.error.message}`),
        input_tokens: llmResult.inputTokens,
        output_tokens: llmResult.outputTokens,
        duration_ms: llmResult.durationMs,
        used_llm: true,
      };
    }

    const { say, actions: rawActions, claims } = parsed.data;

    // Sprint 6.5 — Caminho B: hidrata cada action com meta determinístico.
    const turnIndex = context.state.turn_index + 1;
    const emittedAt = new Date().toISOString();
    const { actions, invalid_indexes } = hydrateGeneratorActions(rawActions as GeneratorRawAction[], {
      conversation_id: context.conversation_id,
      turn_index: turnIndex,
      emitted_at: emittedAt,
      selected_skill: decision.output.skill,
      latest_customer_message_id: latestCustomerMessageId(context),
    });

    if (invalid_indexes.length > 0) {
      logger.warn(
        { conversation_id: context.conversation_id, invalid_indexes },
        'generator: actions com payload inválido — bloqueando turno',
      );
      return {
        ...fallbackResult(
          `generator_action_hydration_failed:indexes=${invalid_indexes.join(',')}`,
        ),
        claims, // audit: preserva claims que o Generator emitiu mesmo com action invalida
        prompt_version: parsed.data.prompt_version, // versao REAL emitida pelo LLM
        candidate_say_text: say,
        candidate_actions: actions,
        candidate_raw_actions: rawActions,
        input_tokens: llmResult.inputTokens,
        output_tokens: llmResult.outputTokens,
        duration_ms: llmResult.durationMs,
        used_llm: true,
      };
    }

    const validation = runValidators(say, actions, claims, toolResults, context, decision.output.skill);

    return {
      say_text: validation.blocked ? null : say,
      actions: validation.blocked ? [] : actions,
      claims, // audit: SEMPRE preserva claims emitidos (mesmo se blocked pelo claim-validator)
      prompt_version: parsed.data.prompt_version, // versao REAL emitida pelo LLM (v1.4.0 ou v1.5.0)
      blocked: validation.blocked,
      block_reason: validation.block_reason,
      candidate_say_text: validation.blocked ? say : null,
      candidate_actions: validation.blocked ? actions : [],
      candidate_raw_actions: validation.blocked ? rawActions : undefined,
      used_llm: true,
      fallback_used: false,
      input_tokens: llmResult.inputTokens,
      output_tokens: llmResult.outputTokens,
      duration_ms: llmResult.durationMs,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.warn(
      {
        conversation_id: context.conversation_id,
        error: errorMsg,
        had_llm_result: llmResult !== undefined,
        output_tokens: llmResult?.outputTokens,
      },
      'generator: LLM call failed — usando fallback',
    );
    return {
      ...fallbackResult(`generator_llm_failed:${errorMsg}`),
      input_tokens: llmResult?.inputTokens ?? 0,
      output_tokens: llmResult?.outputTokens ?? 0,
      duration_ms: llmResult?.durationMs ?? (Date.now() - startedAt),
      used_llm: true,
    };
  }
}

function temperatureForModel(model: string): number | undefined {
  return supportsCustomTemperature(model) ? 0.2 : undefined;
}

function supportsCustomTemperature(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return /^(gpt-4o|gpt-4\.1)(?:$|[-_])/.test(normalized);
}

function latestCustomerMessageId(context: PlannerContext): string | null {
  for (let index = context.recent_messages.length - 1; index >= 0; index -= 1) {
    const message = context.recent_messages[index]!;
    if (message.role === 'customer') return message.id;
  }
  return null;
}

// ------------------------------------------------------------------
// Persistência de auditoria
// ------------------------------------------------------------------

/**
 * Grava resultado em agent.turns e agent.session_events.
 * Retorna o turn_id gerado.
 * Nunca envia ao Chatwoot.
 *
 * Sprint 6.5: actions persistidas via applyActionAndPersist são responsabilidade
 * do caller (worker), não desta função. Esta função só registra auditoria do turno.
 */
export async function recordGeneratorResult(
  client: PoolClient,
  context: PlannerContext,
  selectedSkill: SkillName,
  result: GeneratorResult,
  triggerMessageId: string,
): Promise<string> {
  const turnId = deterministicUuid([
    'generator_turn',
    context.environment,
    context.conversation_id,
    String(context.state.turn_index + 1),
    generatorAgentVersion,
    triggerMessageId,
  ]);

  const contextHash = deterministicUuid([
    'context_hash',
    context.environment,
    context.conversation_id,
    String(context.state.turn_index + 1),
  ]);

  // Grava em agent.turns — shadow: status='generated' ou 'blocked'.
  // Não preenche delivered_message_id (envio não existe ainda).
  const blockedSayText = result.blocked ? result.candidate_say_text : null;
  const blockedActions = result.blocked ? result.candidate_actions : [];
  // Audit Etapa 2: claims emitidos pelo Generator ficam no payload pra
  // separar "Generator afirmou e validator passou" de "Generator nao afirmou
  // nada comercial". Sem isso nao da pra medir adocao de claims.
  // Defensivo contra fixtures/mocks legados que nao incluem claims.
  const claimsForAudit = result.claims ?? [];
  const claimTypes = claimsForAudit.map((c) => c.type);
  // Audit v1.5.0-fix: usa a versao REAL do prompt (v1.4.0 ou v1.5.0), nao a
  // constante fixa. Sem isso, baterias A/B com a feature flag confundiriam
  // analise futura porque DB diria que tudo eh v1.4.0.
  const auditPromptVersion = result.prompt_version ?? generatorPromptVersion;
  const blockedPayload = result.blocked
    ? {
        say_text: blockedSayText,
        actions: blockedActions,
        claims: claimsForAudit,
        raw_actions: result.candidate_raw_actions ?? null,
        block_reason: result.block_reason,
        used_llm: result.used_llm,
        fallback_used: result.fallback_used,
        prompt_version: auditPromptVersion,
        agent_version: generatorAgentVersion,
        input_tokens: result.input_tokens,
        output_tokens: result.output_tokens,
        duration_ms: result.duration_ms,
      }
    : null;

  await client.query(
    `INSERT INTO agent.turns
       (id, environment, conversation_id, trigger_message_id,
        selected_skill, agent_version, context_hash,
        say_text, actions, status,
        llm_duration_ms, llm_input_tokens, llm_output_tokens,
        error_message, blocked_say_text, blocked_actions, blocked_payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     ON CONFLICT (environment, trigger_message_id, agent_version) DO NOTHING`,
    [
      turnId,
      context.environment,
      context.conversation_id,
      triggerMessageId,
      selectedSkill,
      generatorAgentVersion,
      contextHash,
      result.blocked ? null : result.say_text,
      JSON.stringify(result.blocked ? [] : result.actions),
      result.blocked ? 'blocked' : 'generated',
      result.duration_ms,
      result.input_tokens,
      result.output_tokens,
      result.block_reason,
      blockedSayText,
      JSON.stringify(blockedActions),
      blockedPayload ? JSON.stringify(blockedPayload) : null,
    ],
  );

  // Grava evento de auditoria em agent.session_events.
  await client.query(
    `INSERT INTO agent.session_events
       (environment, conversation_id, turn_index, event_type, skill_name,
        event_payload, emitted_by, action_id)
     VALUES ($1, $2, $3, 'generator_produced', $4, $5, 'system', $6)
     ON CONFLICT (action_id) DO NOTHING`,
    [
      context.environment,
      context.conversation_id,
      context.state.turn_index + 1,
      selectedSkill,
      JSON.stringify({
        turn_id: turnId,
        say_text: result.blocked ? null : result.say_text,
        blocked: result.blocked,
        block_reason: result.block_reason,
        blocked_say_text: blockedSayText,
        blocked_actions_count: blockedActions.length,
        actions_count: result.actions.length,
        // Audit Etapa 2: claims emitidos pelo Generator (sempre, mesmo se blocked).
        // claims_count + claim_types permitem query rapida em SQL sem unnest.
        claims: claimsForAudit,
        claims_count: claimsForAudit.length,
        claim_types: claimTypes,
        used_llm: result.used_llm,
        fallback_used: result.fallback_used,
        prompt_version: auditPromptVersion, // versao real (v1.4 ou v1.5)
        agent_version: generatorAgentVersion,
        input_tokens: result.input_tokens,
        output_tokens: result.output_tokens,
        duration_ms: result.duration_ms,
        // Self-correction: presente apenas quando o worker repetiu o turn.
        self_correction_round: result.self_correction_round ?? 1,
        self_correction_previous_reason: result.self_correction_previous_reason ?? null,
      }),
      deterministicUuid([
        'generator_produced',
        context.environment,
        context.conversation_id,
        String(context.state.turn_index + 1),
        generatorAgentVersion,
      ]),
    ],
  );

  return turnId;
}

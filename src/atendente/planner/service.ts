import type { PoolClient } from 'pg';
import { env } from '../../shared/config/env.js';
import { deterministicUuid } from '../../shared/deterministic-id.js';
import {
  callOpenAIResponse,
  isReasoningModel,
  supportsCustomTemperature,
} from '../../shared/llm-clients/openai.js';
import { sessionSlotKeySchema } from '../../shared/zod/agent-state.js';
import type { PlannerContext } from './context-builder.js';
import { buildPlannerMessages } from './prompt.js';
import {
  fallbackPlannerOutput,
  plannerOutputJsonSchema,
  plannerOutputSchema,
  plannerPromptVersion,
  riskFlagSchema,
  toolRequestSchema,
  type PlannerOutput,
} from './schemas.js';

export interface PlannerDecisionResult {
  output: PlannerOutput;
  used_llm: boolean;
  fallback_used: boolean;
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
}

export async function planTurn(context: PlannerContext): Promise<PlannerDecisionResult> {
  if (!env.PLANNER_LLM_ENABLED) {
    return {
      output: mockPlanTurn(context),
      used_llm: false,
      fallback_used: false,
      input_tokens: 0,
      output_tokens: 0,
      duration_ms: 0,
    };
  }

  if (!env.PLANNER_OPENAI_API_KEY) {
    return fallbackResult('planner_llm_enabled_without_planner_openai_key');
  }

  const startedAt = Date.now();
  try {
    const first = await callPlannerModel(context);
    return {
      output: first.output,
      used_llm: true,
      fallback_used: false,
      input_tokens: first.inputTokens,
      output_tokens: first.outputTokens,
      duration_ms: first.durationMs,
    };
  } catch (firstError) {
    try {
      const retry = await callPlannerModel(context, firstError instanceof Error ? firstError.message : String(firstError));
      return {
        output: retry.output,
        used_llm: true,
        fallback_used: false,
        input_tokens: retry.inputTokens,
        output_tokens: retry.outputTokens,
        duration_ms: retry.durationMs,
      };
    } catch (retryError) {
      return {
        output: fallbackPlannerOutput(
          retryError instanceof Error ? `planner_schema_failed:${retryError.message}` : 'planner_schema_failed',
        ),
        used_llm: true,
        fallback_used: true,
        input_tokens: 0,
        output_tokens: 0,
        duration_ms: Date.now() - startedAt,
      };
    }
  }
}

export async function recordPlannerDecision(
  client: PoolClient,
  context: PlannerContext,
  decision: PlannerDecisionResult,
): Promise<void> {
  await client.query(
    `INSERT INTO agent.session_events
       (environment, conversation_id, turn_index, event_type, skill_name,
        event_payload, emitted_by, action_id)
     VALUES ($1, $2, $3, 'planner_decided', $4, $5, 'system', $6)
     ON CONFLICT (action_id) DO NOTHING`,
    [
      context.environment,
      context.conversation_id,
      context.state.turn_index + 1,
      decision.output.skill,
      JSON.stringify({
        planner_output: decision.output,
        used_llm: decision.used_llm,
        fallback_used: decision.fallback_used,
        model: decision.used_llm ? env.PLANNER_MODEL : 'mock',
        prompt_version: plannerPromptVersion,
        input_tokens: decision.input_tokens,
        output_tokens: decision.output_tokens,
        duration_ms: decision.duration_ms,
      }),
      deterministicUuid([
        'planner_decided',
        context.environment,
        context.conversation_id,
        context.state.turn_index + 1,
        plannerPromptVersion,
      ]),
    ],
  );
}

function mockPlanTurn(context: PlannerContext): PlannerOutput {
  const last = [...context.recent_messages].reverse().find((message) => message.role === 'customer');
  const text = last?.text.toLowerCase() ?? '';
  const environment = context.environment;

  if (text.includes('humano') || text.includes('atendente')) {
    return {
      skill: 'escalar_humano',
      missing_slots: [],
      tool_requests: [],
      risk_flags: ['human_requested'],
      confidence: 0.95,
      rationale: 'Cliente pediu atendimento humano.',
      prompt_version: plannerPromptVersion,
    };
  }

  if (mentionsStoreInfoQuestion(text) && context.available_tools.includes('buscarPoliticaComercial')) {
    return {
      skill: 'responder_geral',
      missing_slots: [],
      tool_requests: [{ tool: 'buscarPoliticaComercial', input: { environment } }],
      risk_flags: [],
      confidence: 0.85,
      rationale: 'Cliente perguntou sobre informacao geral da loja.',
      prompt_version: plannerPromptVersion,
    };
  }

  if (mentionsPolicyQuestion(text) && context.available_tools.includes('buscarPoliticaComercial')) {
    return {
      skill: 'tratar_objecao',
      missing_slots: [],
      tool_requests: [{ tool: 'buscarPoliticaComercial', input: { environment } }],
      risk_flags: [],
      confidence: 0.82,
      rationale: 'Cliente perguntou sobre politica comercial.',
      prompt_version: plannerPromptVersion,
    };
  }

  if (text.includes('frete') || text.includes('entrega')) {
    const bairro = context.state.global_slots.bairro?.value_json ?? findOrganizerStringFact(context, [
      'bairro_mencionado',
    ]);
    return {
      skill: 'responder_logistica',
      missing_slots: typeof bairro === 'string' ? [] : ['bairro'],
      tool_requests:
        typeof bairro === 'string'
          ? [{ tool: 'calcularFrete', input: { environment, bairro } }]
          : [],
      risk_flags: ['mentions_delivery'],
      confidence: 0.78,
      rationale: 'Cliente perguntou sobre logistica/frete.',
      prompt_version: plannerPromptVersion,
    };
  }

  if (text.includes('caro') || text.includes('desconto')) {
    return {
      skill: 'tratar_objecao',
      missing_slots: [],
      tool_requests: [{ tool: 'buscarPoliticaComercial', input: { environment, policy_keys: ['desconto_maximo'] } }],
      risk_flags: ['mentions_discount'],
      confidence: 0.8,
      rationale: 'Cliente levantou objecao comercial.',
      prompt_version: plannerPromptVersion,
    };
  }

  const activeItem = context.state.items.find((item) => item.is_active);
  const medida = activeItem?.slots.medida_pneu?.value_json ?? findOrganizerStringFact(context, [
    'medida_pneu',
  ]);
  const marca = activeItem?.slots.marca_preferida?.value_json ?? findOrganizerStringFact(context, [
    'marca_pneu_preferida',
  ]);
  const moto = activeItem?.slots.moto_modelo?.value_json ?? findOrganizerStringFact(context, [
    'moto_modelo',
  ]);
  if (typeof medida === 'string' || typeof marca === 'string') {
    return {
      skill: 'buscar_e_ofertar',
      missing_slots: [],
      tool_requests: [
        {
          tool: 'buscarProduto',
          input: {
            environment,
            medida_pneu: typeof medida === 'string' ? medida : undefined,
            marca: typeof marca === 'string' ? marca : undefined,
            apenas_com_estoque: true,
            limit: 10,
          },
        },
      ],
      risk_flags: ['mentions_stock', 'mentions_price'],
      confidence: 0.82,
      rationale: 'Ha dados suficientes para buscar produto.',
      prompt_version: plannerPromptVersion,
    };
  }

  if (typeof moto === 'string') {
    return {
      skill: 'pedir_dados_faltantes',
      missing_slots: ['medida_pneu'],
      tool_requests: [{ tool: 'buscarCompatibilidade', input: { environment, moto_modelo: moto, limit: 10 } }],
      risk_flags: [],
      confidence: 0.7,
      rationale: 'Cliente informou moto, mas ainda falta medida/confirmacao.',
      prompt_version: plannerPromptVersion,
    };
  }

  return {
    skill: 'pedir_dados_faltantes',
    missing_slots: ['moto_modelo', 'medida_pneu'],
    tool_requests: [],
    risk_flags: [],
    confidence: 0.6,
    rationale: 'Ainda faltam dados para buscar produto com seguranca.',
    prompt_version: plannerPromptVersion,
  };
}

function findOrganizerStringFact(context: PlannerContext, factKeys: string[]): string | undefined {
  const fact = context.organizer_facts.find(
    (candidate) => factKeys.includes(candidate.fact_key) && isUsableOrganizerFact(candidate),
  );
  return extractStringValue(fact?.fact_value);
}

function isUsableOrganizerFact(fact: PlannerContext['organizer_facts'][number]): boolean {
  if (fact.truth_type === 'predicted') return false;
  return fact.confidence_level === null || fact.confidence_level >= 0.5;
}

function extractStringValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;

  const record = value as Record<string, unknown>;
  for (const key of ['text', 'value', 'size', 'brand', 'name', 'modelo']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
  }

  return undefined;
}

async function callPlannerModel(
  context: PlannerContext,
  previousError?: string,
): Promise<{ output: PlannerOutput; inputTokens: number; outputTokens: number; durationMs: number }> {
  const messages = buildPlannerMessages(context);
  if (previousError) {
    messages.push({
      role: 'user',
      content: `Seu output anterior falhou no schema: ${previousError}. Retorne somente JSON valido.`,
    });
  }

  const reasoningEnabled = isReasoningModel(env.PLANNER_MODEL);
  const result = await callOpenAIResponse({
    apiKey: env.PLANNER_OPENAI_API_KEY!,
    model: env.PLANNER_MODEL,
    messages,
    timeoutMs: env.OPENAI_TIMEOUT_MS,
    // Reasoning models (gpt-5.x) gastam tokens "pensando" antes de responder.
    // 800 tokens estourava no meio do output -> JSON truncado -> "Unterminated string".
    // 3000 da espaço pra reasoning + output completo. Modelos nao-reasoning seguem em 800.
    maxTokens: reasoningEnabled ? 3000 : 800,
    // Reasoning models (gpt-5.x) NAO aceitam parametro temperature — HTTP 400.
    // So passa temperature pra modelos GPT-4o/4.1 que aceitam.
    temperature: supportsCustomTemperature(env.PLANNER_MODEL) ? 0 : undefined,
    // Reasoning dinamico: 'none' apos trivial, 'low' nos demais casos.
    // Corta ~40-50% dos reasoning tokens vs default 'medium'.
    reasoning: reasoningEnabled
      ? { effort: effortForContext(context.last_skill) }
      : undefined,
    // Verbosity baixa: resposta mais concisa, ~15-20% menos tokens de output.
    verbosity: reasoningEnabled ? 'low' : undefined,
    jsonSchema: {
      name: 'planner_output',
      schema: plannerOutputJsonSchema,
      strict: true,
    },
  });
  return {
    output: plannerOutputSchema.parse(normalizePlannerOutputCandidate(JSON.parse(result.content), context)),
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    durationMs: result.durationMs,
  };
}

export function normalizePlannerOutputCandidate(raw: unknown, context: PlannerContext): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;

  const candidate = raw as Record<string, unknown>;
  let normalizedToolRequests = normalizeToolRequests(candidate.tool_requests, context);
  const rawMissingSlots = Array.isArray(candidate.missing_slots) ? candidate.missing_slots : [];
  const missingSlots = rawMissingSlots.filter((slot) => sessionSlotKeySchema.safeParse(slot).success);
  const rawRiskFlags = Array.isArray(candidate.risk_flags) ? candidate.risk_flags : [];
  const riskFlags = rawRiskFlags.filter((flag) => riskFlagSchema.safeParse(flag).success);

  const normalized: Record<string, unknown> = {
    ...candidate,
    missing_slots: missingSlots,
    tool_requests: normalizedToolRequests,
    risk_flags: riskFlags,
    prompt_version: plannerPromptVersion,
  };

  // Etapa 3: removidos os blocos de "patch" que liam customer text via regex
  // (mentionsProductCompatibilityQuestion, mentionsPolicyQuestion,
  // mentionsStoreInfoQuestion). Esses patches existiam porque o Planner LLM
  // as vezes errava roteamento, e o codigo tentava adivinhar a intencao do
  // cliente por palavras-chave — algo que Codex e o usuario corretamente
  // identificaram como cerebro de regex que nao escala (cliente fala "ta
  // salgado", "vc traz aqui", "pega na minha" — infinitas variacoes).
  // Agora o roteamento e responsabilidade exclusiva do Planner LLM, com
  // regras mais explicitas no prompt v1.2.8. Se regredir, melhorar prompt.

  // Trava nao-regex que continua valida: buscar_e_ofertar sem tool nao faz
  // sentido (LLM provavelmente alucinou skill). Forca pedir_dados_faltantes.
  if (candidate.skill === 'buscar_e_ofertar' && normalizedToolRequests.length === 0) {
    normalized.skill = 'pedir_dados_faltantes';
    normalized.missing_slots = missingSlots.length > 0 ? missingSlots : ['medida_pneu'];
    normalized.confidence = Math.min(numberOrDefault(candidate.confidence, 0.55), 0.65);
    normalized.rationale = appendRationale(candidate.rationale, 'buscar_e_ofertar sem tool valida; pedindo dados faltantes.');
  }

  return normalized;
}

// Etapa 3: removidas as funcoes regex de detecao de intencao do cliente
// (mentionsProductCompatibilityQuestion, shouldEnsurePolicyTool,
// latestCustomerText, findOrganizerNumberFact, isToolRequest) que existiam
// para "patchar" decisoes do Planner LLM com base em palavras-chave do
// customer text. Codex e usuario chamaram corretamente de regex burro:
// cliente fala "ta salgado", "vc traz aqui", "pega na minha" e infinitas
// variacoes que regex jamais cobre.
//
// mentionsPolicyQuestion e mentionsStoreInfoQuestion abaixo ficam, mas
// SO sao usadas pelo mockPlanTurn (dev-only, quando PLANNER_LLM_ENABLED=
// false). Em prod, quem decide skill+tools eh o Planner LLM diretamente.

/** @internal MOCK-ONLY \u2014 usado apenas em mockPlanTurn. Nao usar em codigo de producao. */
function mentionsPolicyQuestion(text: string): boolean {
  const normalized = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (/\b(parcel|parcela|parcelam|vezes|\d+\s*x)\b/.test(normalized)) return true;
  if (/\b(aceita|aceitam|recebe|recebem)\b[^.!?]*(pix|boleto|cartao|debito|credito|dinheiro)/.test(normalized)) return true;
  if (/\b(pagamento|forma de pagamento|condicao de pagamento|no cartao|cartao muda)\b/.test(normalized)) return true;
  if (/\b(troca|trocar|devolucao|devolver|garantia)\b/.test(normalized)) return true;
  if (/\b(horario|funcionamento|que horas|fecha|fecham|abre|abrem|domingo|sabado)\b/.test(normalized)) return true;
  return false;
}

/** @internal MOCK-ONLY — usado apenas em mockPlanTurn. Nao usar em codigo de producao. */
function mentionsStoreInfoQuestion(text: string): boolean {
  const normalized = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  // perguntas sobre localizacao/endereco
  if (/\b(endereco|onde fica|como chegar|localizacao|maps|link do mapa|onde voces ficam)\b/.test(normalized)) return true;
  // perguntas sobre servicos gerais sem produto mencionado
  if (/\b(faz montagem|fazem montagem|faz balanceamento|tem montagem|tem estacionamento)\b/.test(normalized)) return true;
  // perguntas de horario / dias de funcionamento
  if (/\b(que horas abre|que horas fecha|que horas abrem|que horas fecham|horario de atendimento|quando abrem|quando fecham|aberto agora|voces abrem hoje|abrem hoje)\b/.test(normalized)) return true;
  if (/\b(abrem|abre|fecham|fecha|funcionam|funcionamos)\b/.test(normalized)) return true;
  if (/\b(domingo|feriado)\b/.test(normalized)) return true;
  return false;
}

function normalizeToolRequests(rawToolRequests: unknown, context: PlannerContext): unknown[] {
  if (!Array.isArray(rawToolRequests)) return [];

  const normalized: unknown[] = [];
  for (const rawRequest of rawToolRequests) {
    const request = normalizeToolRequest(rawRequest, context);
    if (request) normalized.push(request);
  }
  return normalized.slice(0, 5);
}

function normalizeToolRequest(rawRequest: unknown, context: PlannerContext): unknown | null {
  if (!rawRequest || typeof rawRequest !== 'object' || Array.isArray(rawRequest)) return null;

  const request = rawRequest as Record<string, unknown>;
  const tool = request.tool;
  if (typeof tool !== 'string') return null;

  const input = stripNullish(inputRecord(request.input));
  input.environment = typeof input.environment === 'string' ? input.environment : context.environment;
  normalizeCommonToolInput(input);

  if (tool === 'buscarProduto') enrichBuscarProdutoInput(input, context);
  if (tool === 'buscarCompatibilidade') enrichBuscarCompatibilidadeInput(input, context);
  if (tool === 'calcularFrete') enrichCalcularFreteInput(input, context);

  const candidate = { tool, input };
  const parsed = toolRequestSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function inputRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}

function stripNullish(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null && value !== undefined));
}

function normalizeCommonToolInput(input: Record<string, unknown>): void {
  if (typeof input.posicao_pneu === 'string') {
    const normalizedPosition = normalizeTirePosition(input.posicao_pneu);
    if (normalizedPosition) input.posicao_pneu = normalizedPosition;
  }

  if (typeof input.moto_ano === 'string' && /^\d{4}$/.test(input.moto_ano.trim())) {
    input.moto_ano = Number(input.moto_ano.trim());
  }

  if (typeof input.limit === 'string' && /^\d+$/.test(input.limit.trim())) {
    input.limit = Number(input.limit.trim());
  }
}

function normalizeTirePosition(value: string): 'front' | 'rear' | 'both' | undefined {
  const normalized = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
  if (['front', 'dianteiro', 'frente'].includes(normalized)) return 'front';
  if (['rear', 'traseiro', 'tras'].includes(normalized)) return 'rear';
  if (['both', 'ambos', 'par', 'dianteiro e traseiro', 'frente e tras'].includes(normalized)) return 'both';
  return undefined;
}

function enrichBuscarProdutoInput(input: Record<string, unknown>, context: PlannerContext): void {
  const activeItem = context.state.items.find((item) => item.is_active) ?? context.state.items[0];
  if (typeof input.medida_pneu !== 'string') {
    input.medida_pneu = slotString(activeItem?.slots.medida_pneu?.value_json) ?? findOrganizerStringFact(context, ['medida_pneu']);
  }
  if (typeof input.marca !== 'string') {
    input.marca = slotString(activeItem?.slots.marca_preferida?.value_json) ?? findOrganizerStringFact(context, ['marca_pneu_preferida', 'marca_preferida']);
  }
  if (typeof input.posicao_pneu !== 'string') {
    const position = slotString(activeItem?.slots.posicao_pneu?.value_json) ?? findOrganizerStringFact(context, ['posicao_pneu']);
    const normalizedPosition = position ? normalizeTirePosition(position) : undefined;
    if (normalizedPosition) input.posicao_pneu = normalizedPosition;
  }
}

function enrichBuscarCompatibilidadeInput(input: Record<string, unknown>, context: PlannerContext): void {
  const activeItem = context.state.items.find((item) => item.is_active) ?? context.state.items[0];
  if (typeof input.moto_modelo !== 'string') {
    input.moto_modelo = slotString(activeItem?.slots.moto_modelo?.value_json) ?? findOrganizerStringFact(context, ['moto_modelo']);
  }
  if (typeof input.moto_ano !== 'number') {
    const year = slotString(activeItem?.slots.moto_ano?.value_json) ?? findOrganizerStringFact(context, ['moto_ano']);
    if (year && /^\d{4}$/.test(year.trim())) input.moto_ano = Number(year.trim());
  }
}

function enrichCalcularFreteInput(input: Record<string, unknown>, context: PlannerContext): void {
  if (typeof input.bairro !== 'string') {
    input.bairro = slotString(context.state.global_slots.bairro?.value_json) ?? findOrganizerStringFact(context, ['bairro_mencionado', 'bairro']);
  }
  if (typeof input.municipio !== 'string') {
    input.municipio = slotString(context.state.global_slots.municipio?.value_json) ?? findOrganizerStringFact(context, ['municipio_mencionado', 'municipio']);
  }
}

function slotString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function appendRationale(value: unknown, suffix: string): string {
  const prefix = typeof value === 'string' && value.trim() !== '' ? value.trim() : 'planner output normalizado.';
  return `${prefix} ${suffix}`.slice(0, 500);
}

function fallbackResult(reason: string): PlannerDecisionResult {
  return {
    output: fallbackPlannerOutput(reason),
    used_llm: false,
    fallback_used: true,
    input_tokens: 0,
    output_tokens: 0,
    duration_ms: 0,
  };
}

/**
 * Escolhe reasoning.effort baseado na skill DO TURN ANTERIOR.
 * NAO classifica mensagem do cliente — usa sinal ja existente em agent.session_events.
 *
 * - Turn anterior foi conversa trivial (responder_geral / escalar_humano) -> 'none'
 *   (proximo turn provavelmente tambem eh simples; reasoning quase 0)
 * - Demais casos / primeiro turn -> 'low' (default balanceado, ~40% mais barato que medium)
 *
 * Skills "complexas" (buscar_e_ofertar, registrar_intencao_fechamento) NAO recebem
 * boost — Planner lida bem com confidence 0.90+ mesmo em 'low' (conv 608 confirma).
 *
 * Se qualidade cair, encurtar a lista de triviais ou forçar 'low' fixo.
 */
function effortForContext(lastSkill: string | undefined): 'none' | 'low' {
  if (!lastSkill) return 'low';
  const triviais = new Set(['responder_geral', 'escalar_humano']);
  return triviais.has(lastSkill) ? 'none' : 'low';
}

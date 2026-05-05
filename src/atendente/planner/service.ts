import type { PoolClient } from 'pg';
import { env } from '../../shared/config/env.js';
import { deterministicUuid } from '../../shared/deterministic-id.js';
import { callOpenAI } from '../../shared/llm-clients/openai.js';
import type { PlannerContext } from './context-builder.js';
import { buildPlannerMessages } from './prompt.js';
import {
  fallbackPlannerOutput,
  plannerOutputSchema,
  plannerPromptVersion,
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

  const result = await callOpenAI({
    apiKey: env.PLANNER_OPENAI_API_KEY!,
    model: env.PLANNER_MODEL,
    messages,
    timeoutMs: env.OPENAI_TIMEOUT_MS,
    maxTokens: 800,
    temperature: 0,
  });
  return {
    output: plannerOutputSchema.parse(JSON.parse(result.content)),
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    durationMs: result.durationMs,
  };
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

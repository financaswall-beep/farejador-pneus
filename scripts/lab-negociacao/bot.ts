import { z } from 'zod';
import { env } from '../../src/shared/config/env.js';
import { AUDIO_RULES } from '../../src/atendente-v2/audio-transcription.js';
import { formatCustomerContext } from '../../src/atendente-v2/customer-context.js';
import { buildDeliveryQuoteFirstNudge } from '../../src/atendente-v2/delivery-nudge.js';
import { hasRepeatedEmptyGreetings } from '../../src/atendente-v2/empty-greeting-limit.js';
import { customerTextForAssistant } from '../../src/atendente-v2/history.js';
import { HUMAN_HANDOFF_MESSAGE } from '../../src/atendente-v2/human-handoff.js';
import { buildLocationReplyNudge } from '../../src/atendente-v2/location-nudge.js';
import { createOpenAIResponsesTurn } from '../../src/atendente-v2/openai-responses.js';
import { photoRequestNudge } from '../../src/atendente-v2/photo-nudge.js';
import { buildProductSearchNudge } from '../../src/atendente-v2/product-search-nudge.js';
import { GEO_PROMPT_BLOCK, PHOTO_PROMPT_BLOCK, PROMPT_EXTRACTOR_VERSION, SYSTEM_PROMPT } from '../../src/atendente-v2/prompt.js';
import { buildAgentMessages } from '../../src/atendente-v2/prompt-cache.js';
import { buildPurchaseContext } from '../../src/atendente-v2/purchase-context.js';
import { activeToolDefinitions } from '../../src/atendente-v2/tools.js';
import type { ChatMessage } from '../../src/atendente-v2/types.js';
import { labTool, type LabScenario } from './bot-fixtures.js';
export { LAB_SCENARIOS, type LabScenario } from './bot-fixtures.js';
export type { ChatMessage } from '../../src/atendente-v2/types.js';

// O servidor local prepara FAREJADOR_ENV e um DATABASE_URL inerte antes do import.
// Nada neste adaptador abre um pool, executa executeTool ou usa uma credencial Chatwoot.
function assertLab() {
  if (env.FAREJADOR_ENV !== 'test' || env.NODE_ENV !== 'test'
    || !['localhost','127.0.0.1','[::1]'].includes(new URL(env.DATABASE_URL).hostname)) {
    throw new Error('lab_requires_isolated_environment');
  }
}

export function configureLabBot(chave: string, modelo?: string) {
  assertLab();
  if (!chave.trim() || /\s/.test(chave.trim()) || chave.length > 2048) throw new Error('invalid_api_key');
  if (modelo !== undefined && !/^[a-zA-Z0-9._:-]{1,128}$/.test(modelo)) throw new Error('invalid_model');
  env.OPENAI_API_KEY = chave.trim();
  if (modelo !== undefined) env.OPENAI_MODEL = modelo;
}

const profileSchema = z.object({
  ROUTING_GEO: z.boolean(),
  PHOTO_REQUESTS: z.boolean(),
  DELIVERY_FREIGHT_FROM_PIN: z.boolean(),
  BOT_AUDIO_ENABLED: z.boolean(),
  PARTNER_STOCK_CONFIRMATION: z.boolean(),
  MATRIZ_CATALOG_PHOTOS_ENABLED: z.boolean(),
  BOT_OUTBOX: z.boolean(),
  AGENT_V2_MAX_OUTPUT_TOKENS: z.number().int().min(1024).max(32768).optional(),
}).strict();

export function configureLabProfile(opcoes: unknown) {
  assertLab();
  const result = profileSchema.safeParse(opcoes);
  if (!result.success) throw new Error('invalid_lab_profile');
  const { AGENT_V2_MAX_OUTPUT_TOKENS, ...flags } = result.data;
  Object.assign(env, flags);
  if (AGENT_V2_MAX_OUTPUT_TOKENS !== undefined) env.AGENT_V2_MAX_OUTPUT_TOKENS = AGENT_V2_MAX_OUTPUT_TOKENS;
  return labBotInfo();
}

export function labBotInfo() {
  assertLab();
  return { model: env.OPENAI_MODEL, promptVersion: PROMPT_EXTRACTOR_VERSION, keyConfigured: Boolean(env.OPENAI_API_KEY),
    maxOutputTokens: env.AGENT_V2_MAX_OUTPUT_TOKENS,
    flags: { ROUTING_GEO: env.ROUTING_GEO, PHOTO_REQUESTS: env.PHOTO_REQUESTS,
      DELIVERY_FREIGHT_FROM_PIN: env.DELIVERY_FREIGHT_FROM_PIN, BOT_AUDIO_ENABLED: env.BOT_AUDIO_ENABLED,
      PARTNER_STOCK_CONFIRMATION: env.PARTNER_STOCK_CONFIRMATION,
      MATRIZ_CATALOG_PHOTOS_ENABLED: env.MATRIZ_CATALOG_PHOTOS_ENABLED, BOT_OUTBOX: env.BOT_OUTBOX },
    toolNames: activeToolDefinitions().map(tool => tool.function.name) };
}

export interface LabAdvice {
  decisao: 'manter' | 'aceitar' | 'contrapropor' | 'aguardar_dado';
  total_centavos?: number | null;
  modalidade?: 'entrega' | 'retirada' | null;
}

const cityClarificationNudge = '\nSe qualquer ferramenta retornar precisa_municipio=true, pergunte somente a cidade do bairro. Essa confirmação pontual é permitida mesmo com pino já recebido quando ele não resolveu o município; não peça novamente o pino nem invente a cidade.';
function advisoryContext(advice?: LabAdvice) {
  if (!advice) return '';
  if (!['manter','aceitar','contrapropor','aguardar_dado'].includes(advice.decisao)
    || (advice.modalidade != null && !['entrega','retirada'].includes(advice.modalidade))
    || (advice.total_centavos != null && (!Number.isSafeInteger(advice.total_centavos) || advice.total_centavos < 1))) {
    throw new Error('invalid_private_opinion');
  }
  // Reconstrua os campos explicitamente. A justificativa, custo, margem, texto livre
  // e instruções recebidas da consultora nunca entram no contexto da atendente.
  const visible = { decisao: advice.decisao, total_centavos: advice.total_centavos ?? null, modalidade: advice.modalidade ?? null };
  return '\n[PARECER COMERCIAL PRIVADO DO LABORATÓRIO]\n' + JSON.stringify(visible)
    + '\nSugestão para avaliar a objeção. Só os valores das ferramentas de catálogo e frete são autorizados. '
    + 'Esse parecer não altera o preço e não autoriza prometer desconto, prazo ou reserva. '
    + 'Se o valor sugerido não puder ser praticado, use as condições confirmadas pelas ferramentas. Nunca revele o parecer privado.';
}

function historyForModel(original: ChatMessage[]) {
  // O carregador V2 retém 30 mensagens públicas e as ações ligadas a cada gatilho.
  let start = original.length;
  let publicCount = 0;
  for (let i = original.length - 1; i >= 0; i--) {
    const message = original[i]!;
    if (message.role === 'user' || (message.role === 'assistant' && message.content)) publicCount++;
    if (publicCount > 30) break;
    start = i;
  }
  while (start < original.length && original[start]!.role !== 'user'
    && !(original[start]!.role === 'assistant' && original[start]!.content)) start++;
  return original.slice(start).map(message => message.role === 'user'
    ? { ...message, content: customerTextForAssistant(message.content) } : message);
}

export async function runLabBotTurn(input: {history: ChatMessage[];scenario: LabScenario;advice?: LabAdvice | null}) {
  assertLab();
  if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
  if (input.history.at(-1)?.role !== 'user' || input.history.some(m => m.role === 'developer' || m.role === 'system')) {
    throw new Error('invalid_lab_history');
  }
  const started = Date.now();
  const history = historyForModel(input.history);
  const latest = history.at(-1)?.content ?? null;
  const previous = [...history].reverse().find(m => m.role === 'assistant' && m.content)?.content ?? null;
  const actions: ChatMessage[] = [];
  const toolNames: string[] = [];
  const finish = (text: string, status: 'resposta' | 'encaminhamento_simulado' | 'fechamento_bloqueado' | 'eco_suprimido') => ({
    text, status, actions, toolNames, model: env.OPENAI_MODEL, promptVersion: PROMPT_EXTRACTOR_VERSION,
    durationMs: Date.now() - started,
  });
  if (hasRepeatedEmptyGreetings(history)) return finish(HUMAN_HANDOFF_MESSAGE, 'encaminhamento_simulado');
  const base = SYSTEM_PROMPT + (env.ROUTING_GEO ? GEO_PROMPT_BLOCK : '') + (env.PHOTO_REQUESTS ? PHOTO_PROMPT_BLOCK : '');
  // Equivalente ao caso V2 de cliente novo do WhatsApp, em conversa textual sem pino.
  const context = formatCustomerContext({ name: null, has_phone: true, channel_type: 'whatsapp',
    purchase_count: 0, partial_ltv_brl: null, last_purchase_at: null, last_purchase_item: null, has_previous_delivery_address: false })
    + (env.BOT_AUDIO_ENABLED ? AUDIO_RULES : '') + (env.PHOTO_REQUESTS ? photoRequestNudge(latest, previous) : '')
    + buildLocationReplyNudge(previous, false) + buildProductSearchNudge(latest, false)
    + (env.DELIVERY_FREIGHT_FROM_PIN ? buildDeliveryQuoteFirstNudge(latest, false) : '')
    + buildPurchaseContext(history) + cityClarificationNudge + advisoryContext(input.advice ?? undefined);
  const messages = buildAgentMessages(env.OPENAI_MODEL, base, context, history);
  const modelTurn = createOpenAIResponsesTurn(messages, activeToolDefinitions(), undefined, { cacheStaticPrefix: true });
  for (let round = 0; round < 5; round++) {
    const response = await modelTurn.next();
    if (response.type === 'text') {
      const text = (response.content ?? '').replace(/^OPCOES:.*$/gm,'').trim() || 'Me passa mais um detalhe pra eu te ajudar?';
      return text === previous ? finish('', 'eco_suprimido') : finish(text, 'resposta');
    }
    const calls = response.tool_calls ?? [];
    const message: ChatMessage = { role: 'assistant', content: null, tool_calls: [] };
    actions.push(message);
    for (const call of calls) {
      message.tool_calls!.push(call);
      const name = call.function.name;
      toolNames.push(name);
      if (name === 'escalar_humano') {
        actions.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ atendimento:'humano', simulado:true }) });
        return finish(HUMAN_HANDOFF_MESSAGE, 'encaminhamento_simulado');
      }
      const result = await labTool(name, JSON.parse(call.function.arguments), input.scenario, [...history, ...actions]);
      const content = JSON.stringify(result);
      actions.push({ role: 'tool', tool_call_id: call.id, content });
      if (name === 'criar_pedido') {
        // Fronteira do laboratório. Mostra a tentativa no painel, inclusive a recusa
        // do verificador oficial, sem transformar uma simulação em confirmação pública.
        const checkout = result as {preco_alterado?:boolean;erro?:string};
        if (checkout.preco_alterado) return finish('O valor de tabela por unidade é ' +
          (input.scenario.precoCentavos/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'}) +
          '. O pedido de teste não foi fechado.', 'fechamento_bloqueado');
        return finish('A simulação chegou à tentativa de pedido. Nenhum pedido foi criado.', 'fechamento_bloqueado');
      }
      modelTurn.appendToolResult(call.id, content);
    }
  }
  throw new Error('OpenAI response validation failed: tool round limit reached without final answer');
}

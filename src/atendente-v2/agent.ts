import type { PoolClient } from 'pg';
import { pool } from '../persistence/db.js';
import { env } from '../shared/config/env.js';
import { logger } from '../shared/logger.js';
import { loadHistory, lookupChatwootConversationId } from './history.js';
import { getLatestCustomerLocation } from './customer-location.js';
import { haversineKm, type GeoPoint } from '../shared/geo/haversine.js';
import { activeToolDefinitions, executeTool } from './tools.js';
import { sendMessage } from './sender.js';
import { SYSTEM_PROMPT, GEO_PROMPT_BLOCK, PHOTO_PROMPT_BLOCK } from './prompt.js';
import { customerWantsPhoto, PHOTO_NUDGE } from './photo-nudge.js';
import { buildLocationReplyNudge } from './location-nudge.js';
import { ensurePickupMap, extractPickupCardFromActions } from './pickup-map.js';
import { tryCaptureSurveyReply } from './satisfaction.js';
import type { AgentV2JobInput, ChatMessage, ToolCall } from './types.js';
import type { Environment } from '../shared/types/chatwoot.js';

const MAX_TOOL_ROUNDS = 5;
const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';

// Numero maximo de tentativas para a chamada OpenAI quando der AbortError
// (timeout). 1 retry resolve ~90% dos casos de timeout esporadico do reasoning.
const OPENAI_RETRY_ON_TIMEOUT = 1;

/**
 * Le contexto do cliente (nome do Chatwoot, recorrente, total de pedidos, LTV).
 * Retorna string pra injetar no system prompt OU null se nao tiver info util.
 *
 * Filtra nomes invalidos do Chatwoot (numeros de telefone, placeholders,
 * strings vazias) pra evitar bot chamar cliente de "+5521..." ou "Cliente".
 */
function isValidChatwootName(name: string | null): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  if (trimmed.length < 2) return false;
  // Rejeita strings que parecem numero de telefone
  if (/^\+?\d[\d\s\-()]*$/.test(trimmed)) return false;
  // Rejeita placeholders comuns
  const lower = trimmed.toLowerCase();
  const placeholders = ['cliente', 'lead', 'unknown', 'desconhecido', 'visitante', 'no name', 'sem nome', 'whatsapp', 'user'];
  if (placeholders.some((p) => lower === p || lower.startsWith(p + ' '))) return false;
  return true;
}

async function loadCustomerContext(
  client: PoolClient,
  conversationId: string,
): Promise<string | null> {
  try {
    const result = await client.query<{
      name: string | null;
      is_returning: boolean;
      purchase_count: number;
      partial_ltv_brl: string | null;
    }>(
      `SELECT ct.name, cj.is_returning, cj.purchase_count, cj.partial_ltv_brl
       FROM core.conversations c
       JOIN core.contacts ct ON ct.id = c.contact_id
       LEFT JOIN analytics.customer_journey_mv cj ON cj.contact_id = c.contact_id
       WHERE c.id = $1
       LIMIT 1`,
      [conversationId],
    );
    const row = result.rows[0];
    if (!row) return null;

    const hasValidName = isValidChatwootName(row.name);
    const firstName = hasValidName ? (row.name as string).trim().split(/\s+/)[0] : null;

    if (row.is_returning && firstName && row.purchase_count >= 1) {
      return `\n[CONTEXTO CLIENTE] Este cliente já comprou aqui antes. Nome (do Chatwoot): ${firstName}. Total de pedidos anteriores: ${row.purchase_count}. LTV: R$ ${row.partial_ltv_brl ?? '0,00'}. Trate como cliente recorrente — use saudação personalizada com o nome dele, mostre que reconhece. NÃO pergunte o nome dele.`;
    }
    if (firstName) {
      return `\n[CONTEXTO CLIENTE] Nome conhecido do Chatwoot: ${firstName}. Primeira conversa. USE esse nome desde o turno 1 (ex: "Bom dia, ${firstName}!") e NÃO pergunte o nome dele de novo. Se ele se identificar com nome diferente na conversa, prefira o nome novo.`;
    }
    return `\n[CONTEXTO CLIENTE] Nome do cliente NÃO veio do Chatwoot. Pergunte o nome dele em algum momento durante a conversa (ex: turno 2 após cotar).`;
  } catch (err) {
    logger.warn({ err, conversation_id: conversationId }, 'agent_v2: loadCustomerContext falhou (ignorado)');
    return null;
  }
}

/**
 * Distância em LINHA RETA (haversine) do cliente até a loja ATIVA mais perto, em km.
 * Produto-agnóstico, barato e OFFLINE (não chama o Google) — é só pro gancho de calor
 * "você tá a ~X km". O roteamento real continua usando distância de RUA; aqui aproxima.
 * null se não há loja com coordenada.
 */
async function nearestStoreKm(
  client: PoolClient,
  environment: Environment,
  pin: GeoPoint,
): Promise<number | null> {
  const r = await client.query<{ latitude: string | null; longitude: string | null }>(
    `SELECT pu.latitude, pu.longitude
       FROM network.partner_units pu
       JOIN network.partners p ON p.id = pu.partner_id AND p.environment = pu.environment
      WHERE pu.environment = $1 AND pu.status = 'active' AND p.status = 'active'
        AND pu.deleted_at IS NULL AND p.deleted_at IS NULL
        AND pu.latitude IS NOT NULL AND pu.longitude IS NOT NULL`,
    [environment],
  );
  let min: number | null = null;
  for (const row of r.rows) {
    const lat = Number(row.latitude);
    const lng = Number(row.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const km = haversineKm(pin, { lat, lng });
    if (min === null || km < min) min = km;
  }
  return min;
}

export async function runAgentV2(job: AgentV2JobInput): Promise<void> {
  const start = Date.now();
  const { conversationId, environment, jobId } = job;
  const logCtx = { job_id: jobId, conversation_id: conversationId, agent: 'v2' };

  const client = await pool.connect();
  try {
    // 1. Load context (history + chatwoot id + customer journey em paralelo)
    const [history, chatwootConvId, customerContext, customerPin] = await Promise.all([
      loadHistory(client, conversationId, { includeLocationMarkers: env.ROUTING_GEO }),
      lookupChatwootConversationId(client, conversationId),
      loadCustomerContext(client, conversationId),
      // Determinístico: o cliente JÁ mandou o pino? Se sim, o nudge abaixo FORÇA o bot a
      // usar a tool (em vez de pedir o bairro). Pedir no prompt sozinho não bastava — o
      // LLM ignorava (não re-chamava a tool no turno do pino). Ver agent nudge abaixo.
      env.ROUTING_GEO ? getLatestCustomerLocation(client, environment as Environment, conversationId) : Promise.resolve(null),
    ]);

    if (!chatwootConvId) {
      logger.warn(logCtx, 'agent_v2: chatwoot_conversation_id not found, aborting');
      return;
    }

    // 1b. Pesquisa de satisfação (0105): se há pesquisa pendente nesta conversa e o
    // cliente respondeu uma NOTA, grava + agradece e PULA o LLM (é resposta de
    // pesquisa, não pergunta). Dormente com a flag off (tryCaptureSurveyReply retorna
    // false na hora). NÃO toca o fluxo normal quando a mensagem não é uma nota.
    if (env.SATISFACTION_SURVEY) {
      const lastUserText = [...history].reverse().find((m) => m.role === 'user')?.content ?? null;
      const captured = await tryCaptureSurveyReply(client, environment as Environment, chatwootConvId, lastUserText);
      if (captured) {
        logger.info(logCtx, 'agent_v2: resposta de pesquisa de satisfacao capturada (skip LLM)');
        return;
      }
    }

    // 2. Build messages — anexa contexto de cliente recorrente ao system prompt se houver.
    // Bloco GEO só entra com ROUTING_GEO on (flag OFF = prompt byte a byte o de hoje).
    // Distância (linha reta) até a loja mais perto — só pro gancho de calor (perto/longe).
    const nearestKm = customerPin
      ? await nearestStoreKm(client, environment as Environment, customerPin)
      : null;
    const kmRounded = nearestKm != null ? Math.round(nearestKm) : null;

    let basePrompt = env.ROUTING_GEO ? SYSTEM_PROMPT + GEO_PROMPT_BLOCK : SYSTEM_PROMPT;
    // Foto sob demanda: bloco só com a flag on (off = prompt byte a byte o de hoje,
    // preserva o prompt caching; a tool pedir_foto também some — activeToolDefinitions).
    if (env.PHOTO_REQUESTS) basePrompt += PHOTO_PROMPT_BLOCK;
    // Nudge determinístico do PINO: só entra quando o cliente JÁ compartilhou a localização.
    // É uma ordem forte e contextual (alta autoridade, sem diluir) que vence as linhas do
    // prompt que mandam "pegue o bairro" — pra o bot CHAMAR a tool em vez de re-perguntar.
    const proximidadeHook =
      kmRounded != null
        ? `\nGANCHO DE PROXIMIDADE (calor, sempre aproximado com "~", NUNCA o número cravado): o cliente está a ~${kmRounded} km da loja mais perto. Use assim: até 5 km → "tá colado / pertíssimo"; 5 a 10 km → "tá pertinho (uns ${kmRounded} km)"; ACIMA de 10 km → NÃO cite o km (longe vira atrito), siga normal. Encaixe leve antes da próxima pergunta e siga a conversa — não trave nisso.`
        : '';
    const pinNudge = customerPin
      ? `\n\n[LOCALIZAÇÃO JÁ RECEBIDA 📍] O cliente JÁ compartilhou a localização dele nesta conversa. Você TEM a localização — NÃO peça o bairro, NÃO pergunte "qual bairro aparece na localização" e NÃO peça pra mandar de novo. Para QUALQUER pergunta sobre estoque, preço na loja, frete, retirada ou "qual a loja/borracharia mais perto", CHAME a ferramenta correspondente AGORA (buscar_produto / buscar_compatibilidade / calcular_frete / localizacao_loja), SEM passar "bairro" — o sistema resolve a cidade e a loja mais perto pela localização. Só volte a pedir o bairro se a ferramenta retornar precisa_localizacao=true.${proximidadeHook}`
      : '';
    // Empurrão determinístico da FOTO (gêmeo do pino): quando o cliente PEDE pra
    // ver o pneu, o bot às vezes confabula ("já pedi pro pessoal") sem chamar a
    // tool pedir_foto — aí nenhum photo_request nasce. Detecta por código e injeta
    // a ordem que proíbe a promessa-sem-chamada. Só com a flag on (off = prompt
    // byte a byte o de hoje, preserva o caching). Ver photo-nudge.ts.
    const reversedHistory = [...history].reverse();
    const latestCustomerText = reversedHistory.find((m) => m.role === 'user')?.content ?? null;
    const lastAssistantText =
      reversedHistory.find((m) => m.role === 'assistant' && m.content)?.content ?? null;
    const photoNudge =
      env.PHOTO_REQUESTS && customerWantsPhoto(latestCustomerText, lastAssistantText) ? PHOTO_NUDGE : '';
    // Empurrão de localização-EM-TEXTO (gêmeo do pino): quando o bot acabou de pedir
    // a localização e o cliente respondeu em texto (sem pino), o LLM às vezes regride —
    // recita o pneu de novo em vez de reconhecer a loja e avançar (conversa 668, 06-16).
    // Permissivo: se o cliente mudou de assunto, manda seguir o cliente (não engessa).
    const locationNudge = buildLocationReplyNudge(lastAssistantText, customerPin != null);
    // Empurrão de MEDIDA DE PNEU: quando o cliente nomeia uma medida (ex: 90/90-12), o
    // LLM às vezes responde "Tenho sim" de cabeça sem chamar buscar_produto — prometendo
    // estoque que não conferiu. Detecta o padrão numérico na última mensagem e injeta
    // ordem forte pro modelo chamar a ferramenta PRIMEIRO. Regex cobre os formatos reais:
    // 90/90-12, 130/70-17, 90/90R18, 3.00-10. NUNCA dispara em mensagens sem medida.
    const TIRE_SIZE_RE = /\d{2,3}[\/\.]\d{2,3}[-\/rR]\d{2}/;
    const productNudge =
      latestCustomerText && TIRE_SIZE_RE.test(latestCustomerText)
        ? '\n\n[MEDIDA DE PNEU DETECTADA] O cliente informou uma medida de pneu na última mensagem. OBRIGATÓRIO: chame buscar_produto com essa medida ANTES de responder. Nunca diga "tenho"/"temos" nem confirme estoque sem o resultado da ferramenta neste turno — responder de memória é PROIBIDO.'
        : '';
    const systemPromptWithContext =
      basePrompt + (customerContext ?? '') + pinNudge + photoNudge + locationNudge + productNudge;

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPromptWithContext },
      ...history,
    ];

    // 3. LLM loop with function calling
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    let finalText: string | null = null;
    // Acumula tool calls + results pra persistir em agent.turns.actions
    const turnActions: ChatMessage[] = [];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await callOpenAIWithTools(messages);
      inputTokens += response.inputTokens;
      outputTokens += response.outputTokens;
      cachedTokens += response.cachedTokens;

      if (response.type === 'text' || !response.tool_calls?.length) {
        finalText = response.content ?? null;
        break;
      }

      // Add assistant message with tool_calls
      const assistantToolMsg: ChatMessage = {
        role: 'assistant',
        content: null,
        tool_calls: response.tool_calls,
      };
      messages.push(assistantToolMsg);
      turnActions.push(assistantToolMsg);

      // Execute all tool calls in parallel (reads only) or serial (writes)
      for (const toolCall of response.tool_calls) {
        let toolArgs: Record<string, unknown> = {};
        try {
          toolArgs = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
        } catch {
          toolArgs = {};
        }

        const isWrite = toolCall.function.name === 'criar_pedido';

        let result: string;
        if (isWrite) {
          // Run inside a transaction for writes
          await client.query('BEGIN');
          try {
            result = await executeTool(client, environment as Environment, conversationId, toolCall.function.name, toolArgs);
            await client.query('COMMIT');
          } catch (err) {
            await client.query('ROLLBACK');
            throw err;
          }
        } else {
          result = await executeTool(client, environment as Environment, conversationId, toolCall.function.name, toolArgs);
        }
        const toolMsg: ChatMessage = { role: 'tool', tool_call_id: toolCall.id, content: result };
        messages.push(toolMsg);
        turnActions.push(toolMsg);
      }
    }

    if (!finalText || finalText.trim().length === 0) {
      logger.warn({ ...logCtx, rounds: MAX_TOOL_ROUNDS, finalText }, 'agent_v2: LLM retornou vazio, nao envia ao Chatwoot');
      return;
    }

    // 4. Send to Chatwoot (strip quick-reply markers from sent text, keep them for reference)
    const textToSend = finalText.replace(/^OPCOES:.*$/gm, '').trim();

    // Salvaguarda: se LLM gerou SO uma linha OPCOES (sem texto principal),
    // o regex deixa o body vazio e o Chatwoot recusa com 'text.body is required'.
    // Fallback humano em vez de quebrar a conversa.
    let finalBody = textToSend.length > 0
      ? textToSend
      : 'Me passa mais um detalhe pra eu te ajudar?';

    if (textToSend.length === 0) {
      logger.warn({ ...logCtx, rawFinalText: finalText }, 'agent_v2: textToSend vazio apos strip OPCOES, usando fallback');
    }

    // GARANTIA DO MAPA NA RETIRADA (decisão Wallace 2026-06-14): o link do Google Maps
    // nunca some do resumo. O LLM escreve o resumo seguindo o prompt, mas prompt é
    // probabilístico (§3) — se o pedido fechou uma RETIRADA com maps_url e o link não
    // veio no texto, anexamos por CÓDIGO. FAIL-SAFE: qualquer erro mantém o texto original.
    if (textToSend.length > 0) {
      try {
        finalBody = ensurePickupMap(finalBody, extractPickupCardFromActions(turnActions));
      } catch (err) {
        logger.warn({ ...logCtx, err }, 'agent_v2: ensurePickupMap falhou, enviando texto original');
      }
    }

    await sendMessage(chatwootConvId, finalBody);

    // 5. Log turn (com actions pra reconstruir histórico de tool calls)
    await client.query(
      `INSERT INTO agent.turns (
         environment, conversation_id, trigger_message_id,
         agent_version, context_hash, say_text, actions,
         llm_input_tokens, llm_output_tokens, llm_duration_ms, status
       ) VALUES ($1, $2, $3, 'v2', '', $4, $5::jsonb, $6, $7, $8, 'delivered')
       ON CONFLICT DO NOTHING`,
      [
        environment,
        conversationId,
        job.triggerMessageId,
        finalBody.slice(0, 4000),
        JSON.stringify(turnActions),
        inputTokens,
        outputTokens,
        Date.now() - start,
      ],
    );

    const cacheHitRate = inputTokens > 0 ? Math.round((cachedTokens / inputTokens) * 100) : 0;
    logger.info(
      {
        ...logCtx,
        duration_ms: Date.now() - start,
        input_tokens: inputTokens,
        cached_tokens: cachedTokens,
        cache_hit_pct: cacheHitRate,
        output_tokens: outputTokens,
        text_length: textToSend.length,
      },
      'agent_v2: turn completed',
    );
  } catch (err) {
    logger.error({ ...logCtx, err }, 'agent_v2: turn failed');
    throw err;
  } finally {
    client.release();
  }
}

// ─── OpenAI Chat Completions with tools ───────────────────────────────────

interface OpenAIChoice {
  message: {
    content: string | null;
    tool_calls?: ToolCall[];
  };
  finish_reason: string;
}

interface OpenAIResponse {
  choices: OpenAIChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    // Tokens reaproveitados do cache automatico da OpenAI.
    // Modelos gpt-5.5+ usam TTL 24h por padrao; modelos antigos 5-10min.
    // Desconto: ate 90% no token cacheado ($0.50/M vs $5/M no gpt-5.5).
    prompt_tokens_details?: { cached_tokens?: number };
  };
  durationMs: number;
}

async function callOpenAIWithTools(messages: ChatMessage[]): Promise<{
  type: 'text' | 'tool_calls';
  content?: string;
  tool_calls?: ToolCall[];
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}> {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  const body = JSON.stringify({
    model: env.OPENAI_MODEL,
    messages,
    tools: activeToolDefinitions(),
    tool_choice: 'auto',
    max_completion_tokens: 1000,
    // Garante TTL de 24h no prompt caching. gpt-5.5+ ja usa 24h por
    // default, mas explicito > implicito. Pra modelos mais antigos
    // (gpt-4o etc) isso forca 24h em vez do default 5-10min.
    prompt_cache_retention: '24h',
  });

  // Retry com backoff: tenta ate OPENAI_RETRY_ON_TIMEOUT + 1 vezes total
  // quando der AbortError (timeout) ou erro 5xx transiente da OpenAI.
  let response: Response | null = null;
  let lastErr: unknown = null;
  const start = Date.now();

  for (let attempt = 0; attempt <= OPENAI_RETRY_ON_TIMEOUT; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.OPENAI_TIMEOUT_MS);

    try {
      response = await fetch(OPENAI_ENDPOINT, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);

      // Retry em 5xx transientes (502/503/504 da OpenAI overload)
      if (response.status >= 500 && response.status < 600 && attempt < OPENAI_RETRY_ON_TIMEOUT) {
        logger.warn({ status: response.status, attempt: attempt + 1 }, 'agent_v2: OpenAI 5xx, retrying');
        const backoffMs = 1000 * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }
      break; // sucesso (ou erro nao-retryavel)
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      const isAbort = err instanceof Error &&
        (err.name === 'AbortError' || err.message.includes('aborted'));

      if (isAbort && attempt < OPENAI_RETRY_ON_TIMEOUT) {
        logger.warn({ attempt: attempt + 1, timeoutMs: env.OPENAI_TIMEOUT_MS }, 'agent_v2: OpenAI timeout, retrying');
        const backoffMs = 1000 * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }
      throw err; // propaga erro nao-retryavel ou apos esgotar retries
    }
  }

  if (!response) {
    throw lastErr instanceof Error ? lastErr : new Error('OpenAI: no response after retries');
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OpenAI error ${response.status}: ${text.slice(0, 300)}`);
  }

  const json = await response.json() as OpenAIResponse;
  json.durationMs = Date.now() - start;

  const choice = json.choices[0];
  if (!choice) throw new Error('OpenAI: empty choices');

  const inputTokens = json.usage?.prompt_tokens ?? 0;
  const outputTokens = json.usage?.completion_tokens ?? 0;
  const cachedTokens = json.usage?.prompt_tokens_details?.cached_tokens ?? 0;

  if (choice.finish_reason === 'tool_calls' && choice.message.tool_calls?.length) {
    return { type: 'tool_calls', tool_calls: choice.message.tool_calls, inputTokens, outputTokens, cachedTokens };
  }

  return { type: 'text', content: choice.message.content ?? '', inputTokens, outputTokens, cachedTokens };
}

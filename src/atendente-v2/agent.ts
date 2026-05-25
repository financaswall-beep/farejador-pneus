import { pool } from '../persistence/db.js';
import { env } from '../shared/config/env.js';
import { logger } from '../shared/logger.js';
import { loadHistory, lookupChatwootConversationId } from './history.js';
import { TOOL_DEFINITIONS, executeTool } from './tools.js';
import { sendMessage } from './sender.js';
import { SYSTEM_PROMPT } from './prompt.js';
import type { AgentV2JobInput, ChatMessage, ToolCall } from './types.js';
import type { Environment } from '../shared/types/chatwoot.js';

const MAX_TOOL_ROUNDS = 5;
const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';

export async function runAgentV2(job: AgentV2JobInput): Promise<void> {
  const start = Date.now();
  const { conversationId, environment, jobId } = job;
  const logCtx = { job_id: jobId, conversation_id: conversationId, agent: 'v2' };

  const client = await pool.connect();
  try {
    // 1. Load context
    const [history, chatwootConvId] = await Promise.all([
      loadHistory(client, conversationId),
      lookupChatwootConversationId(client, conversationId),
    ]);

    if (!chatwootConvId) {
      logger.warn(logCtx, 'agent_v2: chatwoot_conversation_id not found, aborting');
      return;
    }

    // 2. Build messages
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history,
    ];

    // 3. LLM loop with function calling
    let inputTokens = 0;
    let outputTokens = 0;
    let finalText: string | null = null;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await callOpenAIWithTools(messages);
      inputTokens += response.inputTokens;
      outputTokens += response.outputTokens;

      if (response.type === 'text' || !response.tool_calls?.length) {
        finalText = response.content ?? null;
        break;
      }

      // Add assistant message with tool_calls
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: response.tool_calls,
      });

      // Execute all tool calls in parallel (reads only) or serial (writes)
      for (const toolCall of response.tool_calls) {
        let toolArgs: Record<string, unknown> = {};
        try {
          toolArgs = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
        } catch {
          toolArgs = {};
        }

        const isWrite = toolCall.function.name === 'criar_pedido';

        if (isWrite) {
          // Run inside a transaction for writes
          await client.query('BEGIN');
          try {
            const result = await executeTool(client, environment as Environment, conversationId, toolCall.function.name, toolArgs);
            await client.query('COMMIT');
            messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
          } catch (err) {
            await client.query('ROLLBACK');
            throw err;
          }
        } else {
          const result = await executeTool(client, environment as Environment, conversationId, toolCall.function.name, toolArgs);
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
        }
      }
    }

    if (!finalText) {
      logger.warn({ ...logCtx, rounds: MAX_TOOL_ROUNDS }, 'agent_v2: max rounds reached without text response');
      return;
    }

    // 4. Send to Chatwoot (strip quick-reply markers from sent text, keep them for reference)
    const textToSend = finalText.replace(/^OPCOES:.*$/gm, '').trim();
    await sendMessage(chatwootConvId, textToSend);

    // 5. Log turn (lightweight)
    await client.query(
      `INSERT INTO agent.turns (
         environment, conversation_id, trigger_message_id,
         agent_version, context_hash, say_text,
         llm_input_tokens, llm_output_tokens, llm_duration_ms, status
       ) VALUES ($1, $2, $3, 'v2', '', $4, $5, $6, $7, 'delivered')
       ON CONFLICT DO NOTHING`,
      [
        environment,
        conversationId,
        job.triggerMessageId,
        textToSend.slice(0, 4000),
        inputTokens,
        outputTokens,
        Date.now() - start,
      ],
    );

    logger.info(
      {
        ...logCtx,
        duration_ms: Date.now() - start,
        input_tokens: inputTokens,
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
  usage: { prompt_tokens: number; completion_tokens: number };
  durationMs: number;
}

async function callOpenAIWithTools(messages: ChatMessage[]): Promise<{
  type: 'text' | 'tool_calls';
  content?: string;
  tool_calls?: ToolCall[];
  inputTokens: number;
  outputTokens: number;
}> {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  const body = JSON.stringify({
    model: env.OPENAI_MODEL,
    messages,
    tools: TOOL_DEFINITIONS,
    tool_choice: 'auto',
    max_completion_tokens: 1000,
  });

  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.OPENAI_TIMEOUT_MS);

  let response: Response;
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
  } finally {
    clearTimeout(timer);
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

  if (choice.finish_reason === 'tool_calls' && choice.message.tool_calls?.length) {
    return { type: 'tool_calls', tool_calls: choice.message.tool_calls, inputTokens, outputTokens };
  }

  return { type: 'text', content: choice.message.content ?? '', inputTokens, outputTokens };
}

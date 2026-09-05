import { z } from 'zod';
import { env } from '../shared/config/env.js';
import type { ChatMessage, ToolCall, ToolDefinition } from './types.js';
import { requestOpenAIResponse } from './openai-responses-http.js';

const outputSchema = z.array(z.discriminatedUnion('type', [
  z.object({ type: z.literal('reasoning') }).passthrough(),
  z.object({
    type: z.literal('function_call'), call_id: z.string().min(1),
    name: z.string().min(1), arguments: z.string(), status: z.literal('completed').optional(),
  }).passthrough(),
  z.object({
    type: z.literal('message'), role: z.literal('assistant'),
    status: z.literal('completed').optional(),
    phase: z.enum(['commentary', 'final_answer']).nullish(),
    content: z.array(z.discriminatedUnion('type', [
      z.object({ type: z.literal('output_text'), text: z.string() }).passthrough(),
      z.object({ type: z.literal('refusal'), refusal: z.string() }).passthrough(),
    ])),
  }).passthrough(),
]));

const usageSchema = z.object({
  input_tokens: z.number().nonnegative().optional(),
  output_tokens: z.number().nonnegative().optional(),
  input_tokens_details: z.object({ cached_tokens: z.number().nonnegative().optional() }).nullish(),
});

function invalid(detail: string): never {
  // Mensagens técnicas fixas: não incluir texto, argumentos nem reasoning do provedor.
  throw new Error(`OpenAI response validation failed: ${detail}`);
}

function historyToInput(history: ChatMessage[]): Record<string, unknown>[] {
  const input: Record<string, unknown>[] = [];
  for (const message of history) {
    if (message.role === 'tool') {
      if (!message.tool_call_id) invalid('tool history without call_id');
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content ?? '' });
      continue;
    }
    if (message.content !== null) input.push({ role: message.role, content: message.content });
    for (const call of message.tool_calls ?? []) {
      input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
    }
  }
  return input;
}

export interface AgentModelResponse {
  type: 'text' | 'tool_calls';
  content?: string;
  tool_calls?: ToolCall[];
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

/**
 * Estado efêmero de UM job. Reenvia todos os outputs (incluindo reasoning
 * criptografado) entre ferramentas, sem gravá-los no banco ou nos logs.
 * agent.turns.actions continua no formato ChatMessage usado pelo histórico.
 */
export function createOpenAIResponsesTurn(history: ChatMessage[], definitions: ToolDefinition[]) {
  const input = historyToInput(history);
  const tools = definitions.map(({ function: fn }) => ({ type: 'function', ...fn, strict: fn.strict ?? false }));
  const allowedNames = new Set(definitions.map((tool) => tool.function.name));
  const seenCallIds = new Set(input.filter((item) => item.type === 'function_call').map((item) => item.call_id));
  const pendingCalls = new Set<string>();

  return {
    appendToolResult(callId: string, output: string): void {
      if (!pendingCalls.delete(callId)) invalid('unexpected or duplicate tool result');
      input.push({ type: 'function_call_output', call_id: callId, output });
    },

    async next(): Promise<AgentModelResponse> {
      if (pendingCalls.size > 0) invalid('tool results still pending');
      const reasoningModel = /^gpt-5(?:[.-]|$)/.test(env.OPENAI_MODEL);
      const raw = await requestOpenAIResponse(JSON.stringify({
        model: env.OPENAI_MODEL,
        input, tools, tool_choice: 'auto',
        store: false,
        max_output_tokens: env.AGENT_V2_MAX_OUTPUT_TOKENS,
        ...(reasoningModel ? { reasoning: { effort: 'medium' }, include: ['reasoning.encrypted_content'] } : {}),
        // Cache implícito do provedor; não enviar prompt_cache_retention, legado no GPT-5.6.
      }));
      const envelope = z.object({ status: z.string(), output: z.unknown(),
        incomplete_details: z.object({ reason: z.string() }).nullish(), usage: z.unknown().optional(),
      }).safeParse(raw);
      if (!envelope.success) invalid('malformed response');
      if (envelope.data.status !== 'completed') {
        if (envelope.data.status === 'incomplete' && envelope.data.incomplete_details?.reason === 'max_output_tokens') {
          invalid('output token limit reached');
        }
        invalid('response not completed');
      }
      const parsed = outputSchema.safeParse(envelope.data.output);
      if (!parsed.success) invalid('malformed output items');

      const calls: ToolCall[] = [];
      const batchIds = new Set<string>();
      const texts: string[] = [];
      // Validar o lote inteiro ANTES de permitir executar qualquer ferramenta.
      for (const item of parsed.data) {
        if (item.type === 'function_call') {
          if (!allowedNames.has(item.name)) invalid('unavailable tool');
          if (seenCallIds.has(item.call_id) || batchIds.has(item.call_id)) invalid('duplicate tool call_id');
          let args: unknown;
          try { args = JSON.parse(item.arguments); } catch { invalid('invalid tool arguments JSON'); }
          if (typeof args !== 'object' || args === null || Array.isArray(args)) invalid('tool arguments must be an object');
          batchIds.add(item.call_id);
          calls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } });
        } else if (item.type === 'message') {
          for (const content of item.content) {
            if (content.type === 'refusal') invalid('provider refusal');
            if (item.phase !== 'commentary') texts.push(content.text);
          }
        }
      }
      const text = texts.join('\n').trim();
      if (calls.length === 0 && !text) invalid('empty final answer');
      const usage = usageSchema.safeParse(envelope.data.usage ?? {});
      if (!usage.success) invalid('malformed usage');
      // Preservar os itens originais, inclusive phase, ids e campos opacos.
      input.push(...envelope.data.output as Record<string, unknown>[]);
      for (const id of batchIds) { pendingCalls.add(id); seenCallIds.add(id); }
      return {
        ...(calls.length > 0 ? { type: 'tool_calls' as const, tool_calls: calls } : { type: 'text' as const, content: text }),
        inputTokens: usage.data.input_tokens ?? 0,
        outputTokens: usage.data.output_tokens ?? 0,
        cachedTokens: usage.data.input_tokens_details?.cached_tokens ?? 0,
      };
    },
  };
}

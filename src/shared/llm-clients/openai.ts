/**
 * OpenAI chat completions client — Organizadora worker.
 *
 * Uses native fetch (Node >= 20). No SDK dependency.
 * Always requests JSON mode (response_format: json_object).
 * Single retry on transient errors (429, 5xx) with 2s backoff.
 */

import { logger } from '../logger.js';

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OpenAICallOptions {
  apiKey: string;
  model: string;
  messages: OpenAIMessage[];
  timeoutMs: number;
  /** Max output tokens. Default 2000. */
  maxTokens?: number;
  /** Temperature. When omitted, the provider/model default is used. */
  temperature?: number;
}

export interface OpenAICallResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export type OpenAIJsonSchema = Record<string, unknown>;

export interface OpenAIResponseCallOptions extends OpenAICallOptions {
  /** Optional strict JSON schema for Responses API structured output. */
  jsonSchema?: {
    name: string;
    schema: OpenAIJsonSchema;
    strict?: boolean;
  };
}

const OPENAI_CHAT_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const OPENAI_RESPONSES_ENDPOINT = 'https://api.openai.com/v1/responses';
const MAX_RETRIES = 1;

/**
 * Call OpenAI chat completions with JSON mode.
 * Throws on non-retryable errors or if both attempts fail.
 */
export async function callOpenAI(options: OpenAICallOptions): Promise<OpenAICallResult> {
  const { apiKey, model, messages, timeoutMs, maxTokens = 2000, temperature } = options;

  const requestBody: Record<string, unknown> = {
    model,
    response_format: { type: 'json_object' },
    messages,
    max_completion_tokens: maxTokens,
  };
  if (temperature !== undefined) requestBody.temperature = temperature;

  const json = await postOpenAI(OPENAI_CHAT_ENDPOINT, apiKey, requestBody, timeoutMs) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    durationMs: number;
  };

  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('openai: empty content in response');
  }

  return {
    content,
    inputTokens: json.usage?.prompt_tokens ?? 0,
    outputTokens: json.usage?.completion_tokens ?? 0,
    durationMs: json.durationMs,
  };
}

/**
 * Call OpenAI Responses API. Prefer this for current models and structured
 * outputs. When jsonSchema is omitted, JSON object mode is still requested.
 */
export async function callOpenAIResponse(options: OpenAIResponseCallOptions): Promise<OpenAICallResult> {
  const { apiKey, model, messages, timeoutMs, maxTokens = 2000, temperature, jsonSchema } = options;

  const requestBody: Record<string, unknown> = {
    model,
    input: messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    max_output_tokens: maxTokens,
    text: {
      format: jsonSchema
        ? {
            type: 'json_schema',
            name: jsonSchema.name,
            schema: jsonSchema.schema,
            strict: jsonSchema.strict ?? true,
          }
        : { type: 'json_object' },
    },
  };
  if (temperature !== undefined) requestBody.temperature = temperature;

  const json = await postOpenAI(OPENAI_RESPONSES_ENDPOINT, apiKey, requestBody, timeoutMs);
  const content = extractResponsesText(json);
  if (!content) {
    throw new Error('openai: empty content in response');
  }

  return {
    content,
    inputTokens: readNumber(readUsageValue(json, 'input_tokens')) ?? readNumber(readUsageValue(json, 'prompt_tokens')) ?? 0,
    outputTokens: readNumber(readUsageValue(json, 'output_tokens')) ?? readNumber(readUsageValue(json, 'completion_tokens')) ?? 0,
    durationMs: json.durationMs,
  };
}

async function postOpenAI(
  endpoint: string,
  apiKey: string,
  requestBody: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown> & { durationMs: number }> {
  const body = JSON.stringify(requestBody);
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    if (attempt > 0) await sleep(2000);

    const start = Date.now();
    let response: Response;

    try {
      response = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body,
      }, timeoutMs);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      logger.warn({ attempt, err: lastError.message }, 'openai: fetch error, will retry');
      continue;
    }

    const durationMs = Date.now() - start;

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const isRetryable = response.status === 429 || response.status >= 500;

      if (isRetryable && attempt < MAX_RETRIES) {
        lastError = new Error(`openai http ${response.status}: ${text.slice(0, 200)}`);
        logger.warn({ attempt, status: response.status }, 'openai: retryable error');
        continue;
      }

      throw new Error(`openai http ${response.status}: ${text.slice(0, 500)}`);
    }

    const json = await response.json() as Record<string, unknown>;
    return { ...json, durationMs };
  }

  throw lastError ?? new Error('openai: all attempts failed');
}

function extractResponsesText(json: Record<string, unknown>): string | null {
  if (typeof json.output_text === 'string') return json.output_text;
  if (!Array.isArray(json.output)) return null;

  const parts: string[] = [];
  for (const outputItem of json.output) {
    if (!outputItem || typeof outputItem !== 'object') continue;
    const content = (outputItem as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;

    for (const contentItem of content) {
      if (!contentItem || typeof contentItem !== 'object') continue;
      const item = contentItem as { type?: unknown; text?: unknown };
      if ((item.type === 'output_text' || item.type === 'text') && typeof item.text === 'string') {
        parts.push(item.text);
      }
    }
  }

  return parts.length > 0 ? parts.join('') : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readUsageValue(json: Record<string, unknown>, key: string): unknown {
  const usage = json.usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return undefined;
  return (usage as Record<string, unknown>)[key];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

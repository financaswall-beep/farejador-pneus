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

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
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

  const body = JSON.stringify(requestBody);

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(2000);
    }

    const start = Date.now();
    let response: Response;

    try {
      response = await fetchWithTimeout(OPENAI_ENDPOINT, {
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

    const json = await response.json() as {
      choices: Array<{ message: { content: string } }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };

    const content = json.choices[0]?.message?.content;
    if (!content) {
      throw new Error('openai: empty content in response');
    }

    return {
      content,
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
      durationMs,
    };
  }

  throw lastError ?? new Error('openai: all attempts failed');
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

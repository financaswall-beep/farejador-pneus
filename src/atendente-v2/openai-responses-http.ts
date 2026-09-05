import { env } from '../shared/config/env.js';
import { logger } from '../shared/logger.js';

const ENDPOINT = 'https://api.openai.com/v1/responses';

/** Retry apenas do transporte: nenhuma ferramenta é executada neste módulo. */
export async function requestOpenAIResponse(body: string): Promise<unknown> {
  if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');

  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.OPENAI_TIMEOUT_MS);
    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
      if (response.ok) {
        try {
          return await response.json();
        } catch (err) {
          if (err instanceof SyntaxError) throw new Error('OpenAI response validation failed: invalid JSON');
          throw err;
        }
      }
      // Não registrar o corpo de erro: pode conter dados do cliente ou da requisição.
      await response.body?.cancel();
      if (response.status < 500 || response.status >= 600 || attempt === 1) {
        const detail = response.status === 400 ? ': request validation failed' : '';
        throw new Error(`OpenAI error ${response.status}${detail}`);
      }
      logger.warn({ status: response.status, attempt: attempt + 1 }, 'agent_v2: OpenAI 5xx, retrying');
    } catch (err) {
      if (!controller.signal.aborted) throw err;
      if (attempt === 1) throw new Error('OpenAI timeout');
      logger.warn({ attempt: attempt + 1, timeoutMs: env.OPENAI_TIMEOUT_MS }, 'agent_v2: OpenAI timeout, retrying');
    } finally {
      // O timeout cobre também a leitura do corpo, não apenas os headers.
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('OpenAI: no response after retries');
}

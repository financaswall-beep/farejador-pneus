import { env } from '../shared/config/env.js';
import { logger } from '../shared/logger.js';

const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 10_000;

export async function sendMessage(
  chatwootConversationId: number,
  content: string,
): Promise<void> {
  if (!env.CHATWOOT_API_BASE_URL || !env.CHATWOOT_API_TOKEN || !env.CHATWOOT_ACCOUNT_ID) {
    logger.warn({ chatwootConversationId }, 'agent_v2: Chatwoot API not configured, skipping send');
    return;
  }

  const url = `${env.CHATWOOT_API_BASE_URL.replace(/\/$/, '')}/accounts/${env.CHATWOOT_ACCOUNT_ID}/conversations/${chatwootConversationId}/messages`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'api_access_token': env.CHATWOOT_API_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content,
          message_type: 'outgoing',
          content_type: 'text',
          private: false,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < MAX_ATTEMPTS) {
          await sleep(500 * 2 ** (attempt - 1));
          continue;
        }
        throw new Error(`Chatwoot send failed ${response.status}: ${body.slice(0, 200)}`);
      }

      logger.info({ chatwootConversationId, attempt }, 'agent_v2: message sent');
      return;
    } catch (err) {
      clearTimeout(timer);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      throw err;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

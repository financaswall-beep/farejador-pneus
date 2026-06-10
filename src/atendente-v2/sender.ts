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

/**
 * Envia uma IMAGEM (foto sob demanda, 0094) pro cliente via Chatwoot.
 *
 * Multipart de verdade: o campo do arquivo é literalmente `attachments[]`
 * (array param do Rails) e `content` vira a LEGENDA da mesma mensagem.
 * NÃO setar Content-Type manualmente — o fetch monta o boundary sozinho a
 * partir do FormData (setar na mão quebra o multipart).
 *
 * A legenda é OBRIGATÓRIA por contrato nosso: o eco do webhook grava a
 * mensagem em core.messages com content = legenda; sem ela o history.ts
 * descarta a linha (filtro content <> '') e o LLM "esquece" que a foto foi
 * mandada — e promete de novo. (Plano FOTO_SOB_DEMANDA, Tijolo 3.)
 */
export async function sendAttachment(
  chatwootConversationId: number,
  file: { buffer: Buffer; filename: string; contentType: string },
  caption: string,
): Promise<void> {
  if (!env.CHATWOOT_API_BASE_URL || !env.CHATWOOT_API_TOKEN || !env.CHATWOOT_ACCOUNT_ID) {
    logger.warn({ chatwootConversationId }, 'agent_v2: Chatwoot API not configured, skipping attachment');
    return;
  }

  const url = `${env.CHATWOOT_API_BASE_URL.replace(/\/$/, '')}/accounts/${env.CHATWOOT_ACCOUNT_ID}/conversations/${chatwootConversationId}/messages`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      // FormData/Blob nativos (Node >= 18). Recriado a cada tentativa: body de
      // FormData é stream-like e não pode ser reusado após um fetch abortado.
      const form = new FormData();
      form.append('content', caption);
      form.append('message_type', 'outgoing');
      form.append('private', 'false');
      form.append(
        'attachments[]',
        new Blob([new Uint8Array(file.buffer)], { type: file.contentType }),
        file.filename,
      );

      const response = await fetch(url, {
        method: 'POST',
        headers: { api_access_token: env.CHATWOOT_API_TOKEN },
        body: form,
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
        throw new Error(`Chatwoot attachment send failed ${response.status}: ${body.slice(0, 200)}`);
      }

      logger.info({ chatwootConversationId, attempt, bytes: file.buffer.length }, 'agent_v2: attachment sent');
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

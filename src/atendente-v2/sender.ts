import { env } from '../shared/config/env.js';
import { logger } from '../shared/logger.js';
import { ChatwootApiClient, ChatwootApiError } from '../admin/chatwoot-api.client.js';

const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 10_000;

export interface SendMessageResult {
  chatwootMessageId: number | null;
}

export async function sendMessage(
  chatwootConversationId: number,
  content: string,
  echoId?: string,
): Promise<SendMessageResult> {
  const result = await new ChatwootApiClient().sendMessage(chatwootConversationId, content, echoId);
  logger.info(
    { chatwootConversationId, chatwoot_message_id: result.chatwootMessageId ?? null },
    'agent_v2: message sent',
  );
  return result;
}

/** Uma única chamada externa. Retry e ambiguidade pertencem ao worker persistente. */
export async function sendMessageOnce(
  chatwootConversationId: number,
  content: string,
  echoId?: string,
): Promise<SendMessageResult> {
  if (!env.CHATWOOT_API_BASE_URL || !env.CHATWOOT_API_TOKEN || !env.CHATWOOT_ACCOUNT_ID) {
    throw new ChatwootApiError('Chatwoot API configuration is missing');
  }
  const client = new ChatwootApiClient({
    baseUrl: env.CHATWOOT_API_BASE_URL,
    apiToken: env.CHATWOOT_API_TOKEN,
    accountId: env.CHATWOOT_ACCOUNT_ID,
    maxPostAttempts: 1,
  });
  return client.sendMessage(chatwootConversationId, content, echoId);
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
): Promise<SendMessageResult> {
  return sendAttachmentWithAttempts(chatwootConversationId, file, caption, MAX_ATTEMPTS);
}

/** Uma única chamada de anexo para a outbox; timeout fica ambíguo e exige humano. */
export async function sendAttachmentOnce(
  chatwootConversationId: number,
  file: { buffer: Buffer; filename: string; contentType: string },
  caption: string,
): Promise<SendMessageResult> {
  return sendAttachmentWithAttempts(chatwootConversationId, file, caption, 1);
}

async function sendAttachmentWithAttempts(
  chatwootConversationId: number,
  file: { buffer: Buffer; filename: string; contentType: string },
  caption: string,
  maxAttempts: number,
): Promise<SendMessageResult> {
  if (!env.CHATWOOT_API_BASE_URL || !env.CHATWOOT_API_TOKEN || !env.CHATWOOT_ACCOUNT_ID) {
    throw new ChatwootApiError('Chatwoot API configuration is missing');
  }

  const url = `${env.CHATWOOT_API_BASE_URL.replace(/\/$/, '')}/accounts/${env.CHATWOOT_ACCOUNT_ID}/conversations/${chatwootConversationId}/messages`;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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
        await response.text().catch(() => '');
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < maxAttempts) {
          await sleep(500 * 2 ** (attempt - 1));
          continue;
        }
        throw new ChatwootApiError(`Chatwoot attachment send failed with status ${response.status}`, response.status);
      }

      const responseBody = await response.text().catch(() => '');
      let chatwootMessageId: number | null = null;
      try {
        const parsed = JSON.parse(responseBody) as { id?: unknown };
        if (typeof parsed.id === 'number') chatwootMessageId = parsed.id;
      } catch { /* resposta vazia continua sendo aceite da API */ }
      logger.info({ chatwootConversationId, attempt, bytes: file.buffer.length }, 'agent_v2: attachment sent');
      return { chatwootMessageId };
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof ChatwootApiError
          && err.status !== null && err.status !== 429 && err.status < 500) throw err;
      if (attempt < maxAttempts) {
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      if (err instanceof ChatwootApiError) throw err;
      throw new ChatwootApiError(
        err instanceof Error ? err.message : 'Chatwoot attachment send failed',
        null,
      );
    }
  }
  throw new ChatwootApiError('Chatwoot attachment send failed');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

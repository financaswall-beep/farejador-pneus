import { z } from 'zod';
import { env } from '../shared/config/env.js';
import { logger } from '../shared/logger.js';

const DEFAULT_PER_PAGE = 25;
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 10_000;

const payloadItemSchema = z.object({}).catchall(z.unknown());
const chatwootListResponseSchema = z
  .union([
    z
      .object({
        data: z
          .object({
            payload: z.array(payloadItemSchema).default([]),
            meta: z
              .object({
                all_count: z.number().int().nonnegative().optional(),
                per_page: z.number().int().positive().optional(),
              })
              .passthrough()
              .default({}),
          })
          .passthrough(),
      })
      .passthrough()
      .transform((value) => ({
        payload: value.data.payload,
        meta: value.data.meta,
      })),
    z
      .object({
        payload: z.array(payloadItemSchema).default([]),
        meta: z
          .object({
            all_count: z.number().int().nonnegative().optional(),
            per_page: z.number().int().positive().optional(),
          })
          .passthrough()
          .default({}),
      })
      .passthrough(),
  ]);

export interface ChatwootApiClientConfig {
  baseUrl: string;
  accountId: number;
  apiToken: string;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
}

export interface ListConversationsInput {
  since: Date;
  until: Date;
  page: number;
}

export interface ListMessagesInput {
  conversationId: number;
  page: number;
}

export interface ChatwootPage {
  items: Array<Record<string, unknown>>;
  hasMore: boolean;
  page: number;
}

export class ChatwootApiError extends Error {
  readonly status: number | null;
  readonly bodySummary: string | null;

  constructor(message: string, status: number | null = null, bodySummary: string | null = null) {
    super(message);
    this.name = 'ChatwootApiError';
    this.status = status;
    this.bodySummary = bodySummary;
  }
}

function requireChatwootConfig(): ChatwootApiClientConfig {
  if (!env.CHATWOOT_API_BASE_URL || !env.CHATWOOT_API_TOKEN || !env.CHATWOOT_ACCOUNT_ID) {
    throw new ChatwootApiError('Chatwoot API configuration is missing');
  }

  return {
    baseUrl: env.CHATWOOT_API_BASE_URL,
    accountId: env.CHATWOOT_ACCOUNT_ID,
    apiToken: env.CHATWOOT_API_TOKEN,
  };
}

function sanitizeBody(body: string): string {
  return body.replace(/[A-Za-z0-9_-]{20,}/g, '[REDACTED]').slice(0, 300);
}

function shouldRetry(status: number): boolean {
  return status === 429 || status >= 500;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class ChatwootApiClient {
  private readonly baseUrl: string;
  private readonly accountId: number;
  private readonly apiToken: string;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(config: ChatwootApiClientConfig = requireChatwootConfig()) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.accountId = config.accountId;
    this.apiToken = config.apiToken;
    this.fetchFn = config.fetchFn ?? fetch;
    this.sleepFn = config.sleepFn ?? defaultSleep;
  }

  async listConversations(input: ListConversationsInput): Promise<ChatwootPage> {
    const url = new URL(`${this.baseUrl}/accounts/${this.accountId}/conversations`);
    // Chatwoot list conversations does not consistently support updated_at q filters
    // across self-hosted versions. The reconcile service filters the returned page.
    url.searchParams.set('status', 'all');
    url.searchParams.set('page', String(input.page));

    return this.requestPage(url, input.page);
  }

  async listMessages(input: ListMessagesInput): Promise<ChatwootPage> {
    const url = new URL(
      `${this.baseUrl}/accounts/${this.accountId}/conversations/${input.conversationId}/messages`,
    );
    url.searchParams.set('page', String(input.page));

    return this.requestPage(url, input.page);
  }

  /**
   * Cria uma nota interna (private=true) em uma conversa do Chatwoot.
   * Notas internas são visíveis apenas para agentes — não aparecem para o cliente.
   */
  async createNote(chatwootConversationId: number, body: string): Promise<void> {
    const url = new URL(
      `${this.baseUrl}/accounts/${this.accountId}/conversations/${chatwootConversationId}/messages`,
    );
    await this.requestPost(url, {
      content: body,
      message_type: 'outgoing',
      content_type: 'text',
      private: true,
    });
  }

  private async requestPost(url: URL, payload: Record<string, unknown>): Promise<void> {
    const startedAt = Date.now();
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const response = await this.fetchFn(url, {
          method: 'POST',
          headers: {
            'api_access_token': this.apiToken,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        logger.debug(
          {
            status_code: response.status,
            duration_ms: Date.now() - startedAt,
            attempt,
          },
          'chatwoot api post completed',
        );

        if (!response.ok) {
          const bodyText = await response.text();
          if (shouldRetry(response.status) && attempt < MAX_ATTEMPTS) {
            await this.sleepFn(500 * 2 ** (attempt - 1));
            continue;
          }
          throw new ChatwootApiError(
            `Chatwoot API POST failed with status ${response.status}`,
            response.status,
            sanitizeBody(bodyText),
          );
        }

        return;
      } catch (err) {
        clearTimeout(timeout);

        if (err instanceof ChatwootApiError) {
          throw err;
        }

        lastError = err;
        if (attempt < MAX_ATTEMPTS) {
          await this.sleepFn(500 * 2 ** (attempt - 1));
          continue;
        }
      }
    }

    throw new ChatwootApiError(
      lastError instanceof Error ? lastError.message : 'Chatwoot API POST failed',
    );
  }

  private async requestPage(url: URL, page: number): Promise<ChatwootPage> {
    const startedAt = Date.now();
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const response = await this.fetchFn(url, {
          headers: {
            api_access_token: this.apiToken,
          },
          signal: controller.signal,
        });
        clearTimeout(timeout);

        const bodyText = await response.text();
        logger.debug(
          {
            status_code: response.status,
            duration_ms: Date.now() - startedAt,
            attempt,
          },
          'chatwoot api request completed',
        );

        if (!response.ok) {
          if (shouldRetry(response.status) && attempt < MAX_ATTEMPTS) {
            await this.sleepFn(500 * 2 ** (attempt - 1));
            continue;
          }

          throw new ChatwootApiError(
            `Chatwoot API request failed with status ${response.status}`,
            response.status,
            sanitizeBody(bodyText),
          );
        }

        const parsedJson = JSON.parse(bodyText) as unknown;
        const parsed = chatwootListResponseSchema.parse(parsedJson);
        const payload = parsed.payload;
        const allCount = parsed.meta.all_count ?? payload.length;
        const perPage = parsed.meta.per_page ?? (payload.length > 0 ? payload.length : DEFAULT_PER_PAGE);

        return {
          items: payload,
          hasMore: allCount > page * perPage,
          page,
        };
      } catch (err) {
        clearTimeout(timeout);

        if (err instanceof ChatwootApiError) {
          throw err;
        }

        lastError = err;
        if (attempt < MAX_ATTEMPTS) {
          await this.sleepFn(500 * 2 ** (attempt - 1));
          continue;
        }
      }
    }

    throw new ChatwootApiError(
      lastError instanceof Error ? lastError.message : 'Chatwoot API request failed',
    );
  }
}

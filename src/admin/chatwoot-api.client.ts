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

const nullableHourSchema = z.number().int().min(0).max(23).nullable().default(null);
const nullableMinuteSchema = z.number().int().min(0).max(59).nullable().default(null);
const chatwootWorkingHourSchema = z.object({
  day_of_week: z.number().int().min(0).max(6),
  closed_all_day: z.boolean().default(false),
  open_all_day: z.boolean().default(false),
  // O Chatwoot devolve null nestes campos em dias fechados. A validação
  // condicional abaixo continua exigindo números para dias com expediente.
  open_hour: nullableHourSchema,
  open_minutes: nullableMinuteSchema,
  close_hour: nullableHourSchema,
  close_minutes: nullableMinuteSchema,
}).passthrough();

const chatwootInboxSchema = z.object({
  id: z.number().int(),
  working_hours_enabled: z.boolean().default(false),
  timezone: z.string().min(1).default('UTC'),
  working_hours: z.array(chatwootWorkingHourSchema).default([]),
}).passthrough().superRefine((inbox, ctx) => {
  if (!inbox.working_hours_enabled) return;
  inbox.working_hours.forEach((row, index) => {
    if (row.closed_all_day || row.open_all_day) return;
    for (const field of ['open_hour', 'open_minutes', 'close_hour', 'close_minutes'] as const) {
      if (row[field] === null) ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['working_hours', index, field],
        message: 'required for an open business day',
      });
    }
  });
});

export interface ChatwootApiClientConfig {
  baseUrl: string;
  accountId: number;
  apiToken: string;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  /** POST externo: outboxes devem usar 1 para nunca repetir resultado ambíguo em memória. */
  maxPostAttempts?: number;
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

export interface ChatwootInboxBusinessHours {
  id: number;
  workingHoursEnabled: boolean;
  timezone: string;
  workingHours: Array<{
    dayOfWeek: number;
    closedAllDay: boolean;
    openAllDay: boolean;
    openHour: number;
    openMinutes: number;
    closeHour: number;
    closeMinutes: number;
  }>;
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
  private readonly maxPostAttempts: number;

  constructor(config: ChatwootApiClientConfig = requireChatwootConfig()) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.accountId = config.accountId;
    this.apiToken = config.apiToken;
    this.fetchFn = config.fetchFn ?? fetch;
    this.sleepFn = config.sleepFn ?? defaultSleep;
    this.maxPostAttempts = Math.max(1, Math.min(MAX_ATTEMPTS, config.maxPostAttempts ?? MAX_ATTEMPTS));
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

  async getInbox(inboxId: number): Promise<ChatwootInboxBusinessHours> {
    const url = new URL(`${this.baseUrl}/accounts/${this.accountId}/inboxes/${inboxId}`);
    const body = chatwootInboxSchema.parse(await this.requestJson(url));
    return {
      id: body.id,
      workingHoursEnabled: body.working_hours_enabled,
      timezone: body.timezone,
      workingHours: body.working_hours.map((row) => ({
        dayOfWeek: row.day_of_week,
        closedAllDay: row.closed_all_day,
        openAllDay: row.open_all_day,
        openHour: row.open_hour ?? 0,
        openMinutes: row.open_minutes ?? 0,
        closeHour: row.close_hour ?? 0,
        closeMinutes: row.close_minutes ?? 0,
      })),
    };
  }

  /** Define o estado explicitamente; ao contrário de um toggle cego, repetir `resolved` é seguro. */
  async setConversationStatus(chatwootConversationId: number, status: 'resolved'): Promise<void> {
    const url = new URL(
      `${this.baseUrl}/accounts/${this.accountId}/conversations/${chatwootConversationId}/toggle_status`,
    );
    await this.requestPost(url, { status });
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

  /**
   * Envia uma mensagem PÚBLICA (outgoing, private=false) ao cliente, via Chatwoot.
   * Diferente de createNote (nota interna), esta o cliente recebe no WhatsApp.
   *
   * `echoId` viaja no payload como correlação auxiliar. A instalação de produção
   * pode devolvê-lo como null no webhook; prova forte deve casar pelo id numérico
   * retornado pela API (`chatwootMessageId`).
   *
   * Retorna o id da mensagem criada no Chatwoot (ou null se a resposta não trouxe).
   */
  async sendMessage(
    chatwootConversationId: number,
    content: string,
    echoId?: string,
  ): Promise<{ chatwootMessageId: number | null }> {
    const url = new URL(
      `${this.baseUrl}/accounts/${this.accountId}/conversations/${chatwootConversationId}/messages`,
    );
    const payload: Record<string, unknown> = {
      content,
      message_type: 'outgoing',
      content_type: 'text',
      private: false,
    };
    if (echoId) {
      payload.echo_id = echoId;
      payload.content_attributes = { farejador_echo_id:echoId };
    }

    const body = await this.requestPost(url, payload);
    const id = (body as { id?: unknown } | null)?.id;
    return { chatwootMessageId: typeof id === 'number' ? id : null };
  }

  private async requestPost(url: URL, payload: Record<string, unknown>): Promise<unknown> {
    const startedAt = Date.now();
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= this.maxPostAttempts; attempt++) {
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
          if (shouldRetry(response.status) && attempt < this.maxPostAttempts) {
            await this.sleepFn(500 * 2 ** (attempt - 1));
            continue;
          }
          throw new ChatwootApiError(
            `Chatwoot API POST failed with status ${response.status}`,
            response.status,
            sanitizeBody(bodyText),
          );
        }

        const okBody = await response.text();
        try {
          return okBody ? JSON.parse(okBody) : null;
        } catch {
          return null;
        }
      } catch (err) {
        clearTimeout(timeout);

        if (err instanceof ChatwootApiError) {
          throw err;
        }

        lastError = err;
        if (attempt < this.maxPostAttempts) {
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

  private async requestJson(url: URL): Promise<unknown> {
    const startedAt = Date.now();
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await this.fetchFn(url, {
          headers: { api_access_token: this.apiToken },
          signal: controller.signal,
        });
        clearTimeout(timeout);
        const bodyText = await response.text();
        logger.debug({ status_code: response.status, duration_ms: Date.now() - startedAt, attempt },
          'chatwoot api request completed');
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
        return bodyText ? JSON.parse(bodyText) : null;
      } catch (err) {
        clearTimeout(timeout);
        if (err instanceof ChatwootApiError) throw err;
        lastError = err;
        if (attempt < MAX_ATTEMPTS) {
          await this.sleepFn(500 * 2 ** (attempt - 1));
          continue;
        }
      }
    }
    throw new ChatwootApiError(lastError instanceof Error ? lastError.message : 'Chatwoot API request failed');
  }
}

import { z } from 'zod';

const payloadItemSchema = z.object({}).catchall(z.unknown());
export const chatwootListResponseSchema = z
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

export const chatwootInboxSchema = z.object({
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

import { z } from 'zod';

const booleanStringSchema = z.enum(['true', 'false']).default('false').transform((value) => value === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  FAREJADOR_ENV: z.enum(['prod', 'test']),
  PORT: z.string().transform(Number).pipe(z.number().int().min(1).max(65535)).default('3000'),
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.string().transform(Number).pipe(z.number().int().min(1)).default('10'),
  DATABASE_SSL: booleanStringSchema,
  CHATWOOT_HMAC_SECRET: z.string().min(1),
  CHATWOOT_WEBHOOK_MAX_AGE_SECONDS: z.string().transform(Number).pipe(z.number().int().min(1)).default('300'),
  CHATWOOT_API_BASE_URL: z.string().min(1).optional(),
  CHATWOOT_API_TOKEN: z.string().min(1).optional(),
  CHATWOOT_ACCOUNT_ID: z.string().transform(Number).pipe(z.number().int()).optional(),
  ADMIN_AUTH_TOKEN: z.string().min(1),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  SIGNAL_TIMEZONE: z.string().min(1).default('America/Sao_Paulo'),
  // Organizadora (Fase 3)
  ORGANIZADORA_ENABLED: booleanStringSchema,
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_MODEL: z.string().min(1).default('gpt-4o-mini'),
  OPENAI_TIMEOUT_MS: z.string().transform(Number).pipe(z.number().int().min(1000)).default('30000'),
  ORGANIZADORA_DEBOUNCE_SECONDS: z.string().transform(Number).pipe(z.number().int().min(10)).default('90'),
  ORGANIZADORA_POLL_INTERVAL_MS: z.string().transform(Number).pipe(z.number().int().min(1000)).default('5000'),
  ORGANIZADORA_MIN_CONFIDENCE: z.string().transform(Number).pipe(z.number().min(0).max(1)).default('0.55'),
  ORGANIZADORA_STALE_JOB_AFTER_SECONDS: z.string().transform(Number).pipe(z.number().int().min(60)).default('900'),
  PLANNER_LLM_ENABLED: booleanStringSchema,
  PLANNER_OPENAI_API_KEY: z.string().min(1).optional(),
  PLANNER_MODEL: z.string().min(1).default('gpt-4o-mini'),
  // Atendente Shadow Worker (Sprint 5): log-only, sem envio Chatwoot.
  ATENDENTE_SHADOW_ENABLED: booleanStringSchema,
  ATENDENTE_SHADOW_POLL_INTERVAL_MS: z.string().transform(Number).pipe(z.number().int().min(1000)).default('5000'),
  ATENDENTE_CONTEXT_MESSAGES_LIMIT: z.string().transform(Number).pipe(z.number().int().min(1).max(100)).default('20'),
  ATENDENTE_CONTEXT_TOOL_EVENTS_LIMIT: z.string().transform(Number).pipe(z.number().int().min(1).max(50)).default('5'),
  ATENDENTE_CONTEXT_ORGANIZER_FACTS_LIMIT: z.string().transform(Number).pipe(z.number().int().min(1).max(100)).default('25'),
  // Generator Shadow (Sprint 6): gera resposta candidata auditavel, sem envio Chatwoot.
  GENERATOR_LLM_ENABLED: booleanStringSchema,
  GENERATOR_OPENAI_API_KEY: z.string().min(1).optional(),
  GENERATOR_MODEL: z.string().min(1).default('gpt-4o-mini'),
  SKIP_EVENT_TYPES: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    ),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n');
    throw new Error('Invalid environment variables:\n' + issues);
  }

  return parsed.data;
}

export const env = parseEnv();

import { z } from 'zod';

const booleanStringSchema = z.enum(['true', 'false']).default('false').transform((value) => value === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  FAREJADOR_ENV: z.enum(['prod', 'test']),
  PORT: z.string().transform(Number).pipe(z.number().int().min(1).max(65535)).default('3000'),
  DATABASE_URL: z.string().min(1),
  // Etapa 5 da auditoria 2026-05-21: pool separado pro Portal Parceiro com
  // role sem BYPASSRLS. Opcional pra nao quebrar ambientes que ainda nao
  // configuraram (dev/test/staging). Em prod, deve estar setado.
  PARTNER_DATABASE_URL: z.string().min(1).optional(),
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
  ATENDENTE_CONTEXT_TOOL_EVENTS_LIMIT: z.string().transform(Number).pipe(z.number().int().min(1).max(50)).default('7'),
  ATENDENTE_CONTEXT_ORGANIZER_FACTS_LIMIT: z.string().transform(Number).pipe(z.number().int().min(1).max(100)).default('25'),
  // Generator Shadow (Sprint 6): gera resposta candidata auditavel, sem envio Chatwoot.
  GENERATOR_LLM_ENABLED: booleanStringSchema,
  GENERATOR_OPENAI_API_KEY: z.string().min(1).optional(),
  GENERATOR_MODEL: z.string().min(1).default('gpt-4o-mini'),
  /**
   * Etapa 5 (v1.5.0): quando true, o Generator usa o prompt few-shot
   * (10 exemplos canonicos, ~1700 tokens) em vez do prompt declarativo
   * v1.4.0 (~3700 tokens com regras + claims). Feature flag pra rodar
   * A/B em catalog15-rerun sem comitar a troca.
   */
  GENERATOR_PROMPT_FEW_SHOT_ENABLED: booleanStringSchema,
  /**
   * v1.6.0 (Modular, 2026-05-24): quando true, o Generator usa prompt
   * modular (common + skill especializada via router). Tokens cai de
   * ~5.144 (v1.5) pra ~2.426 (media v1.6, -53%). Feature flag pra
   * desativar rapido sem revert de codigo se houver regressao.
   * Precedencia: MODULAR_ENABLED=true bypassa FEW_SHOT_ENABLED.
   */
  GENERATOR_PROMPT_MODULAR_ENABLED: booleanStringSchema,
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

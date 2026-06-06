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
  // OpenAI (usado pelo Agent V2)
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_MODEL: z.string().min(1).default('gpt-4o-mini'),
  OPENAI_TIMEOUT_MS: z.string().transform(Number).pipe(z.number().int().min(1000)).default('30000'),
  SKIP_EVENT_TYPES: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    ),
  // Agent V2 Worker (substitui ATENDENTE_SHADOW_*): poll de ops.atendente_jobs,
  // executa runAgentV2 e marca job processed/failed.
  AGENT_V2_WORKER_ENABLED: booleanStringSchema,
  // Chat unificado do Portal Parceiro (Fatia 1): espelha mensagens do Chatwoot em
  // commerce.partner_messages durante a normalizacao. Defensivo e isolado por SAVEPOINT
  // — nunca quebra a normalizacao core. Desligado por padrao.
  PARTNER_CHAT_FANOUT_ENABLED: booleanStringSchema,
  // Fase 2 — Motor de distribuição da Rede (roteamento multi-parceiro). Cada flag
  // DESLIGADA = comportamento de hoje (1 loja por município, LIMIT 1). Liga-se uma
  // por vez, provada no env `test`. Ver docs/FASE2_MOTOR_DISTRIBUICAO_2026-06-06.md.
  //
  // Considera TODOS os parceiros que cobrem a região (não só o mais antigo) e tenta
  // o 2º antes de cair na matriz. Off = decideStoreForItems de hoje, intocado.
  ROUTING_MULTI_CANDIDATE: booleanStringSchema,
  // Ordena os candidatos pela régua de justiça (quem recebeu menos lead em 7d).
  // Só tem efeito com ROUTING_MULTI_CANDIDATE ligada. Off = ordem da query.
  ROUTING_FAIRNESS: booleanStringSchema,
  // Camada GEO — escolhe a loja por PROXIMIDADE real (anel em km que cresce),
  // não por cidade inteira. Ver docs/PLANO_CAMADA_GEO_PROXIMIDADE_REDE_2026-06-06.md.
  // DESLIGADA = roteamento de hoje, byte a byte. Só tem efeito com candidato +
  // coordenada do cliente; sem coordenada cai no caminho atual (fallback por cidade).
  ROUTING_GEO: booleanStringSchema,
  // Usa a distância de RUA do Google (Distance Matrix) em vez de linha reta.
  // Só efeito com ROUTING_GEO on. Off = haversine (linha reta). Liga-se DEPOIS, sozinha.
  ROUTING_GEO_ROAD_DISTANCE: booleanStringSchema,
  // Chave do Google Maps Platform (Geocoding + Distance Matrix). Sem ela, a camada
  // força linha reta mesmo com ROUTING_GEO_ROAD_DISTANCE on (degrada elegante).
  GOOGLE_MAPS_API_KEY: z.string().min(1).optional(),
  AGENT_V2_POLL_INTERVAL_MS: z.string().transform(Number).pipe(z.number().int().min(1000)).default('5000'),
  // Coalescing window: segundos de pausa do cliente antes do bot responder.
  // A cada nova mensagem o timer RESETA. So responde quando o cliente para
  // de digitar por X segundos. Cobre rajadas curtas e longas. Modelo
  // Intercom/Zendesk. Evita o bot responder 3x quando o cliente solta
  // "oi", "bom dia", "tem pneu pra fan?" em sequencia.
  AGENT_V2_DEBOUNCE_SECONDS: z.string().transform(Number).pipe(z.number().int().min(0).max(60)).default('3'),
  // Agent V2: lista de conversation_id (UUID) que usam o agente unificado.
  // Use "*" para rotear todas. Vazio = V2 desligado.
  AGENT_V2_CONVERSATION_IDS: z
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

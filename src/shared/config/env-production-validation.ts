import { z, type RefinementCtx } from 'zod';

// Piso de COMPRIMENTO dos segredos em producao. Mede tamanho, nao aleatoriedade:
// a forca real continua dependendo de gerar os valores com fonte criptografica.
const MIN_SECRET_BYTES = 24;

interface ProductionEnvConfig {
  NODE_ENV: 'development' | 'production' | 'test';
  FAREJADOR_ENV: 'prod' | 'test';
  PARTNER_DATABASE_URL?: string;
  APP_COMMIT_SHA: string;
  ADMIN_BEARER_FALLBACK_ENABLED: boolean;
  ADMIN_AUTH_TOKEN: string;
  CHATWOOT_HMAC_SECRET: string;
  AGENT_V2_WORKER_ENABLED?: boolean;
  BOT_OUTBOX?: boolean;
  OPENAI_API_KEY?: string;
  CHATWOOT_API_BASE_URL?: string;
  CHATWOOT_API_TOKEN?: string;
  CHATWOOT_ACCOUNT_ID?: number;
}

function addIssue(ctx: RefinementCtx, path: string, message: string): void {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
}

function restrictedPartnerUsername(connectionString: string): string | null {
  try {
    const parsedUrl = new URL(connectionString);
    if (parsedUrl.protocol !== 'postgres:' && parsedUrl.protocol !== 'postgresql:') return null;
    return decodeURIComponent(parsedUrl.username);
  } catch {
    // Nunca inclua a URL na mensagem de erro: ela contem a senha do banco.
    return null;
  }
}

export function validateProductionEnv(value: ProductionEnvConfig, ctx: RefinementCtx): void {
  if (value.NODE_ENV !== 'production' || value.FAREJADOR_ENV !== 'prod') return;

  if (!value.PARTNER_DATABASE_URL) {
    addIssue(ctx, 'PARTNER_DATABASE_URL', 'is required in production');
  } else {
    const username = restrictedPartnerUsername(value.PARTNER_DATABASE_URL);
    if (!username || !/^farejador_partner_app(?:\.[a-z0-9]+)?$/.test(username)) {
      addIssue(
        ctx,
        'PARTNER_DATABASE_URL',
        'must use the restricted farejador_partner_app role in production',
      );
    }
  }

  if (value.ADMIN_BEARER_FALLBACK_ENABLED) {
    addIssue(
      ctx,
      'ADMIN_BEARER_FALLBACK_ENABLED',
      'must be false in production after owner bootstrap',
    );
  }
  if (!/^[a-f0-9]{40}$/.test(value.APP_COMMIT_SHA)) {
    addIssue(
      ctx,
      'APP_COMMIT_SHA',
      'must contain the 40-character deployed commit SHA in production',
    );
  }
  if (Buffer.byteLength(value.ADMIN_AUTH_TOKEN, 'utf8') < MIN_SECRET_BYTES) {
    addIssue(ctx, 'ADMIN_AUTH_TOKEN', `must contain at least ${MIN_SECRET_BYTES} bytes in production`);
  }
  if (Buffer.byteLength(value.CHATWOOT_HMAC_SECRET, 'utf8') < MIN_SECRET_BYTES) {
    addIssue(ctx, 'CHATWOOT_HMAC_SECRET', `must contain at least ${MIN_SECRET_BYTES} bytes in production`);
  }
  if (value.AGENT_V2_WORKER_ENABLED) {
    if (!value.OPENAI_API_KEY) {
      addIssue(ctx, 'OPENAI_API_KEY', 'is required in production when AGENT_V2_WORKER_ENABLED=true');
    }
  }
  if (value.AGENT_V2_WORKER_ENABLED || value.BOT_OUTBOX) {
    if (!value.CHATWOOT_API_BASE_URL) {
      addIssue(ctx, 'CHATWOOT_API_BASE_URL', 'is required in production when the bot sender is enabled');
    }
    if (!value.CHATWOOT_API_TOKEN) {
      addIssue(ctx, 'CHATWOOT_API_TOKEN', 'is required in production when the bot sender is enabled');
    }
    if (!value.CHATWOOT_ACCOUNT_ID) {
      addIssue(ctx, 'CHATWOOT_ACCOUNT_ID', 'is required in production when the bot sender is enabled');
    }
  }
}

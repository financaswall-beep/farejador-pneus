/** Trilha best-effort das ações manuais de Marketing, sem segredo nem PII. */
import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';

interface MarketingAuditInput {
  eventType: string;
  actorLabel: string;
  entityTable: string;
  entityId?: string | null;
  idempotencyKey?: string | null;
  payload: Record<string, unknown>;
}

export async function recordMarketingAudit(
  input: MarketingAuditInput,
  dbPool: Pool = defaultPool,
): Promise<boolean> {
  try {
    await dbPool.query(
      `INSERT INTO audit.events (
         environment,domain,entity_table,entity_id,event_type,actor_label,
         idempotency_key,payload_after
       ) VALUES ($1,'marketing',$2,$3,$4,$5,$6,$7::jsonb)`,
      [
        env.FAREJADOR_ENV,
        input.entityTable,
        input.entityId ?? null,
        input.eventType,
        input.actorLabel,
        input.idempotencyKey ?? null,
        JSON.stringify(input.payload),
      ],
    );
    return true;
  } catch (error) {
    logger.warn({ err: error, event_type: input.eventType }, 'marketing audit deferred');
    return false;
  }
}

import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';

export interface OutboundEventInput {
  environment: Environment;
  outboundId: string;
  actor?: string;
  reason?: string | null;
  attempt?: number | null;
  fromStatus?: string | null;
  toStatus: string;
  errorCode?: string | null;
  errorKind?: string | null;
  errorSummary?: string | null;
}

export async function recordOutboundEvent(
  client: PoolClient,
  input: OutboundEventInput,
): Promise<void> {
  await client.query(
    `INSERT INTO ops.outbound_message_events (
       environment,outbound_id,actor,reason,attempt,from_status,to_status,
       error_code,error_kind,error_summary
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [input.environment, input.outboundId, input.actor ?? 'system', input.reason ?? null,
      input.attempt ?? null, input.fromStatus ?? null, input.toStatus,
      input.errorCode ?? null, input.errorKind ?? null, input.errorSummary ?? null],
  );
}

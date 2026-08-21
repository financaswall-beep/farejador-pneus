import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { notifyClientesKanban } from '../../shared/clientes-kanban.notify.js';
import {
  beginIntegrityOperation, completeIntegrityOperation, operationFingerprint,
  recordIntegrityEvent, type MatrizEnvironment,
} from './stage5-integrity.js';

export type CustomerLeadAction = 'move' | 'archive' | 'restore';
export type CustomerLeadManualLane = 'novo' | 'atendimento' | 'orcamento' | 'perdido';

export interface CustomerLeadBoardInput {
  environment: MatrizEnvironment;
  conversationId: string;
  action: CustomerLeadAction;
  lane?: CustomerLeadManualLane;
  expectedVersion: number;
  actor: string;
  reason?: string;
  idempotencyKey: string;
}

export interface CustomerLeadBoardResult {
  conversation_id: string;
  manual_lane: CustomerLeadManualLane | null;
  archived: boolean;
  version: number;
  replayed?: boolean;
}

interface StateRow {
  manual_lane: CustomerLeadManualLane | null;
  archived_at: string | null;
  archived_by: string | null;
  archive_reason: string | null;
  version: number;
}

function normalizedReason(input: CustomerLeadBoardInput): string {
  const supplied = input.reason?.trim();
  if (supplied) return supplied;
  if (input.action === 'archive') return 'Lead arquivado pelo quadro';
  if (input.action === 'restore') return 'Lead restaurado no quadro';
  return 'Lead movido no quadro';
}

function resultFrom(input: CustomerLeadBoardInput, row: StateRow): CustomerLeadBoardResult {
  return {
    conversation_id: input.conversationId,
    manual_lane: row.manual_lane,
    archived: row.archived_at !== null,
    version: Number(row.version),
  };
}

export async function updateCustomerLeadBoard(
  input: CustomerLeadBoardInput,
  dbPool: Pool = defaultPool,
): Promise<CustomerLeadBoardResult> {
  if (input.action === 'move' && !input.lane) throw new Error('lead_lane_required');
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new Error('lead_version_invalid');
  }
  const reason = normalizedReason(input);
  const operation = {
    environment: input.environment,
    domain: 'customer_lead_board',
    idempotencyKey: input.idempotencyKey,
    fingerprint: operationFingerprint({
      conversation_id: input.conversationId, action: input.action, lane: input.lane ?? null,
      expected_version: input.expectedVersion, reason,
    }),
  };
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const replay = await beginIntegrityOperation<CustomerLeadBoardResult>(client, operation);
    if (replay.replayed) {
      await client.query('COMMIT');
      return { ...replay.result, replayed: true };
    }
    const conversation = await client.query(
      `SELECT id FROM core.conversations
        WHERE id=$1 AND environment=$2 AND deleted_at IS NULL FOR UPDATE`,
      [input.conversationId, input.environment],
    );
    if (!conversation.rows[0]) throw new Error('lead_conversation_not_found');
    const beforeQuery = await client.query<StateRow>(
      `SELECT manual_lane,archived_at,archived_by,archive_reason,version
         FROM ops.customer_lead_board_state
        WHERE environment=$1 AND conversation_id=$2 FOR UPDATE`,
      [input.environment, input.conversationId],
    );
    const before = beforeQuery.rows[0] ?? null;
    if (Number(before?.version ?? 0) !== input.expectedVersion) throw new Error('lead_version_conflict');
    let changed;
    if (input.action === 'move') {
      changed = await client.query<StateRow>(
        `INSERT INTO ops.customer_lead_board_state
           (environment,conversation_id,manual_lane,updated_by)
         VALUES($1,$2,$3,$4)
         ON CONFLICT(environment,conversation_id) DO UPDATE SET
           manual_lane=EXCLUDED.manual_lane,version=ops.customer_lead_board_state.version+1,
           updated_by=EXCLUDED.updated_by,updated_at=now()
         RETURNING manual_lane,archived_at,archived_by,archive_reason,version`,
        [input.environment,input.conversationId,input.lane,input.actor],
      );
    } else if (input.action === 'archive') {
      changed = await client.query<StateRow>(
        `INSERT INTO ops.customer_lead_board_state
           (environment,conversation_id,archived_at,archived_by,archive_reason,updated_by)
         VALUES($1,$2,now(),$3,$4,$3)
         ON CONFLICT(environment,conversation_id) DO UPDATE SET
           archived_at=now(),archived_by=EXCLUDED.archived_by,archive_reason=EXCLUDED.archive_reason,
           version=ops.customer_lead_board_state.version+1,updated_by=EXCLUDED.updated_by,updated_at=now()
         RETURNING manual_lane,archived_at,archived_by,archive_reason,version`,
        [input.environment,input.conversationId,input.actor,reason],
      );
    } else {
      if (!before) throw new Error('lead_board_state_not_found');
      changed = await client.query<StateRow>(
        `UPDATE ops.customer_lead_board_state SET archived_at=NULL,archived_by=NULL,
           archive_reason=NULL,version=version+1,updated_by=$3,updated_at=now()
         WHERE environment=$1 AND conversation_id=$2
         RETURNING manual_lane,archived_at,archived_by,archive_reason,version`,
        [input.environment,input.conversationId,input.actor],
      );
    }
    const after = changed.rows[0];
    if (!after) throw new Error('lead_board_update_failed');
    const result = resultFrom(input, after);
    await recordIntegrityEvent(client, {
      environment: input.environment, domain: 'customer_lead_board',
      entityTable: 'ops.customer_lead_board_state', entityId: input.conversationId,
      eventType: `customer_lead_${input.action}`, actorLabel: input.actor,
      idempotencyKey: input.idempotencyKey, before, after: { ...after, reason },
    });
    await completeIntegrityOperation(
      client, operation, 'ops.customer_lead_board_state', input.conversationId, result,
    );
    await notifyClientesKanban(client, input.environment, input.conversationId, 'crm');
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

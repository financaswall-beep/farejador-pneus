import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { beginIntegrityOperation, completeIntegrityOperation, integrityResult,
  operationFingerprint, recordIntegrityEvent, type MatrizEnvironment } from './stage5-integrity.js';
import { linkPurchaseGroupInTransaction, type PurchaseGroupRecordKind } from './purchase-group-links.js';

interface GroupActor { environment?: MatrizEnvironment; actor: string; idempotency_key: string }
export interface PurchaseGroupRow {
  id: string; code: string; name: string; notes: string | null; status: 'open' | 'closed';
  created_at: string; closed_at: string | null; closed_by: string | null;
}
export const groupProjection = `id,'VC-'||lpad(group_number::text,GREATEST(4,length(group_number::text)),'0') code,
 name,notes,status,created_at,closed_at,closed_by`;

async function mutate<T>(input: GroupActor, action: string, payload: object,
  work: (client: import('pg').PoolClient) => Promise<{ id: string; result: T }>, dbPool: Pool) {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const operation = { environment, domain: `wholesale_purchase_group.${action}`,
    idempotencyKey: input.idempotency_key, fingerprint: operationFingerprint(payload) };
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const started = await beginIntegrityOperation<T>(client, operation);
    if (started.replayed) { await client.query('COMMIT'); return started.result; }
    const value = await work(client), result = integrityResult(value.result);
    await recordIntegrityEvent(client, { environment, domain: 'wholesale_purchase_group',
      entityTable: 'commerce.wholesale_purchase_groups', entityId: value.id, eventType: action,
      actorLabel: input.actor, idempotencyKey: input.idempotency_key, after: payload });
    await completeIntegrityOperation(client, operation, 'commerce.wholesale_purchase_groups', value.id, result);
    await client.query('COMMIT'); return result;
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

export async function createPurchaseGroup(input: GroupActor & { name: string; notes?: string | null }, dbPool = defaultPool) {
  const name = input.name.trim(), notes = input.notes?.trim() || null;
  if (name.length < 2 || name.length > 120) throw Error('purchase_group_name_invalid');
  const environment = input.environment ?? env.FAREJADOR_ENV;
  return mutate(input, 'create', { name, notes }, async client => {
    const row = (await client.query<PurchaseGroupRow>(`INSERT INTO commerce.wholesale_purchase_groups
      (environment,name,notes,created_by) VALUES($1,$2,$3,$4) RETURNING ${groupProjection}`,
    [environment, name, notes, input.actor])).rows[0]!;
    return { id: row.id, result: row };
  }, dbPool);
}

export async function changePurchaseGroup(input: GroupActor & {
  group_id: string; action: 'rename' | 'close' | 'reopen' | 'delete'; name?: string; notes?: string | null;
}, dbPool = defaultPool) {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const name = input.name?.trim();
  if (input.action === 'rename' && (!name || name.length < 2 || name.length > 120)) throw Error('purchase_group_name_invalid');
  return mutate(input, input.action, { group_id: input.group_id, name, notes: input.notes }, async client => {
    const row = (await client.query<PurchaseGroupRow>(`SELECT ${groupProjection}
      FROM commerce.wholesale_purchase_groups WHERE environment=$1 AND id=$2 FOR UPDATE`,
    [environment, input.group_id])).rows[0];
    if (!row) throw Error('purchase_group_not_found');
    if (input.action === 'delete') {
      const links = await client.query(`SELECT 1 FROM commerce.wholesale_purchase_group_purchases WHERE environment=$1 AND group_id=$2
        UNION ALL SELECT 1 FROM commerce.wholesale_purchase_group_expenses WHERE environment=$1 AND group_id=$2 LIMIT 1`, [environment, row.id]);
      if (links.rowCount) throw Error('purchase_group_not_empty');
      await client.query('DELETE FROM commerce.wholesale_purchase_groups WHERE environment=$1 AND id=$2', [environment, row.id]);
      return { id: row.id, result: { ...row, deleted: true } };
    }
    const updated = input.action === 'rename'
      ? await client.query<PurchaseGroupRow>(`UPDATE commerce.wholesale_purchase_groups SET name=$3,notes=$4
        WHERE environment=$1 AND id=$2 RETURNING ${groupProjection}`, [environment, row.id, name, input.notes === undefined ? row.notes : input.notes])
      : await client.query<PurchaseGroupRow>(`UPDATE commerce.wholesale_purchase_groups SET status=$3,
        closed_at=CASE WHEN $3='closed' THEN now() ELSE NULL END,closed_by=CASE WHEN $3='closed' THEN $4 ELSE NULL END
        WHERE environment=$1 AND id=$2 RETURNING ${groupProjection}`,
      [environment, row.id, input.action === 'close' ? 'closed' : 'open', input.actor]);
    return { id: row.id, result: updated.rows[0]! };
  }, dbPool);
}

export async function linkPurchaseGroup(input: GroupActor & {
  group_id: string; kind: PurchaseGroupRecordKind; record_id: string; unlink?: boolean;
}, dbPool = defaultPool) {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  return mutate(input, input.unlink ? 'unlink' : 'link', {
    group_id: input.group_id, kind: input.kind, record_id: input.record_id,
  }, async client => {
    await linkPurchaseGroupInTransaction(client, { ...input, environment });
    return { id: input.group_id, result: { linked: !input.unlink, group_id: input.group_id, record_id: input.record_id } };
  }, dbPool);
}

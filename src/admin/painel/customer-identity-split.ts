import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';

export async function splitCustomerIdentity(
  input: { environment: 'prod' | 'test'; identityId: string; linkIds: string[];
    actor: string; reason: string; idempotencyKey: string },
  dbPool: Pool = defaultPool,
): Promise<{ identity_id: string; new_identity_id: string; moved_links: number; replayed?: boolean }> {
  if (input.reason.trim().length < 5) throw new Error('reason_required');
  if (input.idempotencyKey.trim().length < 8) throw new Error('idempotency_key_required');
  const uniqueLinks = [...new Set(input.linkIds)];
  if (uniqueLinks.length === 0) throw new Error('link_ids_required');
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [`customer-split:${input.environment}:${input.idempotencyKey}`]);
    const replay = await client.query<{ payload_after: { identity_id?: string; new_identity_id?: string; moved_links?: number } }>(
      `SELECT payload_after FROM audit.events WHERE environment=$1 AND domain='customer_identity'
        AND event_type='customer_identity_split' AND idempotency_key=$2 LIMIT 1`,
      [input.environment,input.idempotencyKey]);
    const prior = replay.rows[0]?.payload_after;
    if (prior?.new_identity_id) {
      if (prior.identity_id !== input.identityId) throw new Error('idempotency_conflict');
      await client.query('COMMIT');
      return { identity_id: input.identityId,new_identity_id: prior.new_identity_id,
        moved_links: prior.moved_links ?? uniqueLinks.length,replayed: true };
    }
    const identity = await client.query<{ entity_type: string }>(
      `SELECT entity_type FROM commerce.customer_identities
        WHERE id=$1 AND environment=$2 AND status='active' FOR UPDATE`, [input.identityId,input.environment]);
    if (!identity.rows[0]) throw new Error('identity_not_found');
    const links = await client.query<{ id: string }>(
      `SELECT id FROM commerce.customer_identity_links
        WHERE environment=$1 AND identity_id=$2 AND ended_at IS NULL AND id=ANY($3::uuid[]) FOR UPDATE`,
      [input.environment,input.identityId,uniqueLinks]);
    if (links.rows.length !== uniqueLinks.length) throw new Error('split_link_not_found');
    const total = await client.query<{ count: string }>(
      `SELECT count(*)::text count FROM commerce.customer_identity_links
        WHERE environment=$1 AND identity_id=$2 AND ended_at IS NULL`, [input.environment,input.identityId]);
    if (Number(total.rows[0]?.count ?? 0) <= uniqueLinks.length) throw new Error('split_must_leave_source');
    const created = await client.query<{ id: string }>(
      `INSERT INTO commerce.customer_identities(environment,entity_type,decision_actor,decision_reason,decided_at)
       VALUES($1,$2,$3,$4,now()) RETURNING id`,
      [input.environment,identity.rows[0].entity_type,input.actor,input.reason.trim()]);
    const newId = created.rows[0]?.id;
    if (!newId) throw new Error('customer_identity_insert_failed');
    await client.query(
      `UPDATE commerce.customer_identities SET
         type_source_link_id=CASE WHEN type_source_link_id=ANY($1::uuid[]) THEN NULL ELSE type_source_link_id END,
         classification_source_link_id=CASE WHEN classification_source_link_id=ANY($1::uuid[]) THEN NULL ELSE classification_source_link_id END,
         vip_source_link_id=CASE WHEN vip_source_link_id=ANY($1::uuid[]) THEN NULL ELSE vip_source_link_id END
       WHERE id=$2`, [uniqueLinks,input.identityId]);
    await client.query(
      `UPDATE commerce.customer_identity_links SET identity_id=$1
        WHERE environment=$2 AND identity_id=$3 AND id=ANY($4::uuid[])`,
      [newId,input.environment,input.identityId,uniqueLinks]);
    await client.query(
      `UPDATE commerce.customer_identity_candidates SET status='expired',decided_by=$1,
         decision_reason='identity_split',decided_at=now()
       WHERE environment=$2 AND status='pending' AND (left_link_id=ANY($3::uuid[]) OR right_link_id=ANY($3::uuid[]))`,
      [input.actor,input.environment,uniqueLinks]);
    const payload = { identity_id: input.identityId,new_identity_id: newId,moved_links: uniqueLinks.length,
      reason_recorded: true };
    await client.query(
      `INSERT INTO audit.events(environment,domain,entity_table,entity_id,event_type,actor_label,idempotency_key,payload_after)
       VALUES($1,'customer_identity','commerce.customer_identities',$2,'customer_identity_split',$3,$4,$5::jsonb)`,
      [input.environment,input.identityId,input.actor,input.idempotencyKey,JSON.stringify(payload)]);
    await client.query('COMMIT');
    return { identity_id: input.identityId,new_identity_id: newId,moved_links: uniqueLinks.length };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

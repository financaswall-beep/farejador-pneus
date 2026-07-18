import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { normalizeBrazilianPhone } from '../../shared/phone.js';
import { listCustomerSources } from './customer-identity-sources.js';
import type { CustomerSourceRecord } from './customer-identity-types.js';

interface CandidateRow {
  id: string;
  environment: 'prod' | 'test';
  left_link_id: string;
  right_link_id: string;
  signal: 'exact_normalized_phone' | 'explicit_foreign_key' | 'manual';
  score: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  decided_by: string | null;
  decision_reason: string | null;
  created_at: string;
  left_identity_id?: string;
  right_identity_id?: string;
}

async function sourceLink(
  client: PoolClient, source: CustomerSourceRecord, actor: string,
): Promise<{ linkId: string; identityId: string; created: boolean }> {
  const key = `${source.environment}:${source.source_type}:${source.source_id}`;
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
  const existing = await client.query<{ id: string; identity_id: string }>(
    `SELECT id,identity_id FROM commerce.customer_identity_links
      WHERE environment=$1 AND source_type=$2 AND source_id=$3 AND ended_at IS NULL`,
    [source.environment, source.source_type, source.source_id],
  );
  if (existing.rows[0]) {
    return { linkId: existing.rows[0].id, identityId: existing.rows[0].identity_id, created: false };
  }
  const identity = await client.query<{ id: string }>(
    `INSERT INTO commerce.customer_identities(environment,entity_type,decision_actor,decision_reason,decided_at)
     VALUES($1,$2,$3,'initial_source_identity',now()) RETURNING id`,
    [source.environment, source.entity_type, actor],
  );
  const identityId = identity.rows[0]?.id;
  if (!identityId) throw new Error('customer_identity_insert_failed');
  const link = await client.query<{ id: string }>(
    `INSERT INTO commerce.customer_identity_links(
       environment,identity_id,source_type,source_id,owner_scope,partner_unit_id,linked_by,link_reason)
     VALUES($1,$2,$3,$4,$5,$6,$7,'initial_source_identity') RETURNING id`,
    [source.environment, identityId, source.source_type, source.source_id,
      source.owner_scope, source.partner_unit_id, actor],
  );
  const linkId = link.rows[0]?.id;
  if (!linkId) throw new Error('customer_identity_link_insert_failed');
  return { linkId, identityId, created: true };
}

async function mergeStructuralPartnerLinks(
  client: PoolClient, environment: 'prod' | 'test', actor: string,
): Promise<number> {
  const pairs = await client.query<{
    wholesale_identity_id: string; partner_identity_id: string;
  }>(
    `SELECT wl.identity_id wholesale_identity_id,nl.identity_id partner_identity_id
       FROM commerce.wholesale_customers wc
       JOIN commerce.customer_identity_links wl ON wl.environment=wc.environment
        AND wl.source_type='wholesale_customer' AND wl.source_id=wc.id AND wl.ended_at IS NULL
       JOIN commerce.customer_identity_links nl ON nl.environment=wc.environment
        AND nl.source_type='network_partner' AND nl.source_id=wc.partner_id AND nl.ended_at IS NULL
      WHERE wc.environment=$1 AND wc.partner_id IS NOT NULL AND wc.deleted_at IS NULL
        AND wl.identity_id<>nl.identity_id`, [environment]);
  let merged = 0;
  for (const pair of pairs.rows) {
    await client.query(`UPDATE commerce.customer_identity_links SET identity_id=$1 WHERE identity_id=$2 AND environment=$3`,
      [pair.partner_identity_id, pair.wholesale_identity_id, environment]);
    await client.query(
      `UPDATE commerce.customer_identities SET status='merged',superseded_by=$1,
         decision_actor=$2,decision_reason='explicit_wholesale_partner_fk',decided_at=now()
       WHERE id=$3 AND environment=$4 AND status='active'`,
      [pair.partner_identity_id, actor, pair.wholesale_identity_id, environment]);
    merged += 1;
  }
  return merged;
}

async function generatePhoneCandidates(
  client: PoolClient, sources: CustomerSourceRecord[], links: Map<string, { linkId: string; identityId: string }>,
): Promise<number> {
  const byPhone = new Map<string, CustomerSourceRecord[]>();
  for (const source of sources) {
    const phone = normalizeBrazilianPhone(source.phone);
    if (!phone) continue;
    const group = byPhone.get(phone) ?? [];
    group.push(source);
    byPhone.set(phone, group);
  }
  let created = 0;
  for (const group of byPhone.values()) {
    if (group.length < 2 || group.length > 20) continue;
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const first = group[i];
        const second = group[j];
        if (!first || !second) continue;
        const a = links.get(`${first.source_type}:${first.source_id}`);
        const b = links.get(`${second.source_type}:${second.source_id}`);
        if (!a || !b || a.identityId === b.identityId) continue;
        const [left, right] = [a.linkId, b.linkId].sort();
        const result = await client.query(
          `INSERT INTO commerce.customer_identity_candidates(
             environment,left_link_id,right_link_id,signal,score)
           VALUES($1,$2,$3,'exact_normalized_phone',1)
           ON CONFLICT(environment,left_link_id,right_link_id,signal) DO NOTHING`,
          [first.environment, left, right],
        );
        created += result.rowCount ?? 0;
      }
    }
  }
  return created;
}

export async function backfillCustomerIdentities(
  environment: 'prod' | 'test', actor: string, dbPool: Pool = defaultPool,
): Promise<{ sources: number; identities_created: number; structural_merges: number; candidates_created: number }> {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`customer-backfill:${environment}`]);
    let cursor: string | undefined;
    let sources = 0;
    let identitiesCreated = 0;
    const sourceRows: CustomerSourceRecord[] = [];
    const links = new Map<string, { linkId: string; identityId: string }>();
    do {
      const page = await listCustomerSources(environment, { cursor, limit: 200 }, client);
      for (const source of page.rows) {
        const linked = await sourceLink(client, source, actor);
        links.set(`${source.source_type}:${source.source_id}`, linked);
        sourceRows.push(source);
        sources += 1;
        if (linked.created) identitiesCreated += 1;
      }
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    const structuralMerges = await mergeStructuralPartnerLinks(client, environment, actor);
    const refreshed = await client.query<{ source_type: string; source_id: string; id: string; identity_id: string }>(
      `SELECT source_type,source_id::text,id,identity_id FROM commerce.customer_identity_links
        WHERE environment=$1 AND ended_at IS NULL`, [environment]);
    for (const link of refreshed.rows) links.set(`${link.source_type}:${link.source_id}`, { linkId: link.id, identityId: link.identity_id });
    const candidatesCreated = await generatePhoneCandidates(client, sourceRows, links);
    await client.query(
      `INSERT INTO audit.events(environment,domain,entity_table,event_type,actor_label,payload_after)
       VALUES($1,'customer_identity','commerce.customer_identities','customer_identity_backfill',$2,$3::jsonb)`,
      [environment, actor, JSON.stringify({ sources, identities_created: identitiesCreated,
        structural_merges: structuralMerges, candidates_created: candidatesCreated })],
    );
    await client.query('COMMIT');
    return { sources, identities_created: identitiesCreated, structural_merges: structuralMerges,
      candidates_created: candidatesCreated };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function listIdentityCandidates(
  environment: 'prod' | 'test', status: CandidateRow['status'] = 'pending', dbPool: Pool = defaultPool,
): Promise<CandidateRow[]> {
  const result = await dbPool.query<CandidateRow>(
    `SELECT c.id,c.environment,c.left_link_id,c.right_link_id,c.signal,c.score::text,c.status,
            c.decided_by,c.decision_reason,c.created_at::text,
            ll.identity_id::text left_identity_id,rl.identity_id::text right_identity_id
       FROM commerce.customer_identity_candidates c
       JOIN commerce.customer_identity_links ll ON ll.id=c.left_link_id
       JOIN commerce.customer_identity_links rl ON rl.id=c.right_link_id
      WHERE c.environment=$1 AND c.status=$2 ORDER BY c.created_at,c.id LIMIT 200`, [environment, status]);
  return result.rows;
}

export async function decideIdentityCandidate(
  input: { environment: 'prod' | 'test'; candidateId: string; decision: 'approve' | 'reject'; actor: string; reason: string },
  dbPool: Pool = defaultPool,
): Promise<{ id: string; status: string; primary_identity_id?: string }> {
  if (input.reason.trim().length < 5) throw new Error('reason_required');
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`customer-candidate:${input.candidateId}`]);
    const found = await client.query<CandidateRow & { left_identity_id: string; right_identity_id: string }>(
      `SELECT c.*,ll.identity_id left_identity_id,rl.identity_id right_identity_id
         FROM commerce.customer_identity_candidates c
         JOIN commerce.customer_identity_links ll ON ll.id=c.left_link_id
         JOIN commerce.customer_identity_links rl ON rl.id=c.right_link_id
        WHERE c.id=$1 AND c.environment=$2 FOR UPDATE OF c`, [input.candidateId, input.environment]);
    const candidate = found.rows[0];
    if (!candidate) throw new Error('candidate_not_found');
    const target = input.decision === 'approve' ? 'approved' : 'rejected';
    if (candidate.status === target) { await client.query('COMMIT'); return { id: candidate.id, status: target }; }
    if (candidate.status !== 'pending') throw new Error('candidate_already_decided');
    let primary: string | undefined;
    if (input.decision === 'approve') {
      const identities = await client.query<{ id: string }>(
        `SELECT id FROM commerce.customer_identities WHERE id=ANY($1::uuid[]) AND status='active'
          ORDER BY created_at,id FOR UPDATE`, [[candidate.left_identity_id, candidate.right_identity_id]]);
      if (identities.rows.length !== 2) throw new Error('candidate_identity_inactive');
      primary = identities.rows[0]?.id;
      const secondary = identities.rows[1]?.id;
      if (!primary || !secondary) throw new Error('candidate_identity_inactive');
      await client.query(`UPDATE commerce.customer_identity_links SET identity_id=$1 WHERE environment=$2 AND identity_id=$3 AND ended_at IS NULL`,
        [primary, input.environment, secondary]);
      await client.query(
        `UPDATE commerce.customer_identities SET status='merged',superseded_by=$1,decision_actor=$2,
           decision_reason=$3,decided_at=now() WHERE id=$4`, [primary, input.actor, input.reason.trim(), secondary]);
    }
    await client.query(
      `UPDATE commerce.customer_identity_candidates SET status=$1,decided_by=$2,decision_reason=$3,decided_at=now()
        WHERE id=$4`, [target, input.actor, input.reason.trim(), candidate.id]);
    await client.query(
      `INSERT INTO audit.events(environment,domain,entity_table,entity_id,event_type,actor_label,payload_after)
       VALUES($1,'customer_identity','commerce.customer_identity_candidates',$2,$3,$4,$5::jsonb)`,
      [input.environment, candidate.id, `customer_identity_candidate_${target}`, input.actor,
        JSON.stringify({ candidate_id: candidate.id, primary_identity_id: primary ?? null, reason_recorded: true })]);
    await client.query('COMMIT');
    return { id: candidate.id, status: target, ...(primary ? { primary_identity_id: primary } : {}) };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

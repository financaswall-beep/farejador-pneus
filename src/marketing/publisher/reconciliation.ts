import type { Pool } from 'pg';
import { z } from 'zod';
import { MetaCommentError } from '../../social-comments/graph.js';
import { PublisherError, publicationStatus, type Environment } from './model.js';
import { publisherEvent, type Post } from './posts.js';
import type { Delivery, PublicationProof, PublishingGraph } from './graph.js';

export const reconciliationSchema = z.object({
  version: z.number().int().min(1),
  platform: z.enum(['facebook', 'instagram']),
  decision: z.enum(['published', 'not_published', 'abandon']),
  confirmed: z.literal(true),
  provider_id: z.string().regex(/^[0-9_]{1,100}$/).optional(),
  note: z.string().trim().min(10).max(500),
}).strict();
export type Reconciliation = z.infer<typeof reconciliationSchema>;
interface PendingDelivery extends Delivery { status: string; }

async function proofFor(graph: PublishingGraph, delivery: PendingDelivery, input: Reconciliation) {
  if (input.decision === 'abandon') {
    return { outcome: 'unknown', evidence: 'operator_abandoned_no_retry' } satisfies PublicationProof;
  }
  if (input.decision === 'published' && !input.provider_id && !delivery.provider_id) {
    throw new PublisherError('publisher_provider_required', 400);
  }
  try {
    return await graph.reconcile({ ...delivery, provider_id: input.provider_id ?? delivery.provider_id });
  } catch (error) {
    if (error instanceof MetaCommentError) {
      const status = error.code === 'meta_post_owner_mismatch' ? 400 : 503;
      throw new PublisherError(error.code, status);
    }
    throw new PublisherError('publisher_reconciliation_unavailable', 503);
  }
}

/** Uma declaração de ausência, sozinha, nunca habilita outro envio público. */
export async function reconcileDestination(pool: Pool, environment: Environment, id: string,
  input: Reconciliation, actor: string, graph: PublishingGraph) {
  const snapshot = (await pool.query<PendingDelivery>(`SELECT d.*,m.kind media_kind
    FROM ops.publisher_destinations d JOIN ops.publisher_posts p
      ON p.environment=d.environment AND p.id=d.post_id
    JOIN ops.publisher_media m ON m.environment=p.environment AND m.id=p.media_id
    WHERE d.environment=$1 AND d.post_id=$2 AND d.platform=$3`,
  [environment, id, input.platform])).rows[0];
  if (!snapshot) throw new PublisherError('publisher_destination_not_found', 404);
  if (snapshot.status !== 'uncertain') throw new PublisherError('publisher_reconciliation_not_allowed');
  const proof = await proofFor(graph, snapshot, input);
  if (input.decision !== 'abandon' && proof.outcome !== input.decision) {
    throw new PublisherError(proof.outcome === 'published'
      ? 'publisher_already_published' : 'publisher_reconciliation_ambiguous');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const post = (await client.query<Post>(
      'SELECT * FROM ops.publisher_posts WHERE environment=$1 AND id=$2 FOR UPDATE', [environment, id])).rows[0];
    if (!post || post.version !== input.version) throw new PublisherError('publisher_version_conflict');
    const current = (await client.query<PendingDelivery>(`SELECT * FROM ops.publisher_destinations
      WHERE environment=$1 AND post_id=$2 AND platform=$3 FOR UPDATE`, [environment, id, input.platform])).rows[0];
    if (!current || current.status !== 'uncertain' || current.container_id !== snapshot.container_id
      || current.provider_id !== snapshot.provider_id) throw new PublisherError('publisher_reconciliation_not_allowed');
    const status = input.decision === 'published' ? 'published'
      : input.decision === 'not_published' ? 'failed' : 'cancelled';
    await client.query(`UPDATE ops.publisher_destinations SET status=$4,
      provider_id=coalesce($5,provider_id),post_url=coalesce($6,post_url),error_code=$7,
      lease_id=NULL,lease_until=NULL,retry_attempts=0,updated_at=now()
      WHERE environment=$1 AND post_id=$2 AND platform=$3`,
    [environment, id, input.platform, status, proof.provider_id ?? null, proof.url ?? null,
      input.decision === 'not_published' ? 'publisher_verified_not_published'
        : input.decision === 'abandon' ? 'publisher_abandoned_no_retry' : null]);
    const statuses = (await client.query<{ status: string }>(
      'SELECT status FROM ops.publisher_destinations WHERE environment=$1 AND post_id=$2', [environment, id])).rows;
    // Um abandono não autoriza apagar o arquivo que documenta um resultado ambíguo.
    await client.query(`UPDATE ops.publisher_posts SET status=$3,version=version+1,
      delete_after_publish=CASE WHEN $4 THEN false ELSE delete_after_publish END,updated_at=now()
      WHERE environment=$1 AND id=$2`,
    [environment, id, publicationStatus(statuses.map(d => d.status)), input.decision === 'abandon']);
    await publisherEvent(client, environment, id, 'delivery_reconciled', actor, {
      platform: input.platform, decision: input.decision, previous_status: 'uncertain',
      provider_id: proof.provider_id ?? current.provider_id, evidence: proof.evidence,
      note: input.note, version: input.version,
    });
    await client.query('COMMIT');
    return { id, platform: input.platform, status, version: input.version + 1 };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

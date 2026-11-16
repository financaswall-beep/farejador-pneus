import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { MetaCommentError } from '../../social-comments/graph.js';
import { accountId, PublisherError, type Environment } from './model.js';
import { publisherEvent } from './posts.js';
import { publisherTransaction, type PublisherDatabase } from './transaction.js';
import type { InstagramRemovalGraph } from './instagram-removal-graph.js';

export const removalInput = z.object({
  versao: z.number().int().positive(),
  confirmado: z.literal(true).describe('O dono identificou este post e pediu sua exclusão no Instagram. O carrossel inteiro será excluído.'),
}).strict();

export async function requestInstagramRemoval(db: PublisherDatabase, environment: Environment, id: string,
  version: number, actor: string) {
  return publisherTransaction(db, async client => {
    const post = (await client.query('SELECT version FROM ops.publisher_posts WHERE environment=$1 AND id=$2 FOR UPDATE',
      [environment, id])).rows[0];
    if (!post) throw new PublisherError('publisher_post_not_found', 404);
    const dest = (await client.query(`SELECT account_id,provider_id,status,removal_state FROM ops.publisher_destinations
      WHERE environment=$1 AND post_id=$2 AND platform='instagram' FOR UPDATE`, [environment, id])).rows[0];
    if (dest?.account_id !== accountId('instagram') || dest.status !== 'published' || !/^\d{1,40}$/.test(dest.provider_id ?? '')) {
      throw new PublisherError('publisher_removal_requires_published_instagram');
    }
    if (dest.removal_state && dest.removal_state !== 'failed') {
      return { post_id: id, rede: 'instagram', exclusao: dest.removal_state };
    }
    if (post.version !== version) throw new PublisherError('publisher_version_conflict');
    await client.query(`UPDATE ops.publisher_destinations SET removal_state='queued',removal_attempt=$3,
      removal_error=NULL,removal_updated_at=now() WHERE environment=$1 AND post_id=$2 AND platform='instagram'`,
    [environment, id, randomUUID()]);
    await client.query('UPDATE ops.publisher_posts SET version=version+1,updated_at=now() WHERE environment=$1 AND id=$2', [environment, id]);
    await publisherEvent(client, environment, id, 'instagram_removal_requested', actor, { provider_id: dest.provider_id });
    return { post_id: id, rede: 'instagram', exclusao: 'queued' };
  });
}

interface RemovalJob {
  post_id: string; account_id: string; provider_id: string; removal_attempt: string; removal_state: 'queued' | 'sending';
}

export async function instagramRemovalTick(db: Pool, environment: Environment,
  graph: Pick<InstagramRemovalGraph, 'removePublishedMedia'>): Promise<boolean> {
  const job = await publisherTransaction(db, async client => {
    const item = (await client.query<RemovalJob>(`SELECT d.post_id,d.account_id,d.provider_id,d.removal_attempt,d.removal_state
      FROM ops.publisher_destinations d JOIN ops.publisher_posts p ON p.environment=d.environment AND p.id=d.post_id
      WHERE d.environment=$1 AND d.platform='instagram' AND d.status='published'
        AND (removal_state='queued' OR (removal_state='sending' AND removal_updated_at<now()-interval '2 minutes'))
      ORDER BY removal_updated_at LIMIT 1 FOR UPDATE OF p SKIP LOCKED`, [environment])).rows[0];
    if (!item) return;
    const expired = item.removal_state === 'sending';
    const claim = await client.query(`UPDATE ops.publisher_destinations SET removal_state=$3,removal_error=$4,removal_updated_at=now()
      WHERE environment=$1 AND post_id=$2 AND platform='instagram' AND removal_state=$5 AND removal_attempt=$6`,
    [environment, item.post_id, expired ? 'uncertain' : 'sending', expired ? 'publisher_removal_receipt_unknown' : null,
      item.removal_state, item.removal_attempt]);
    if (!claim.rowCount) return;
    if (expired) await publisherEvent(client, environment, item.post_id, 'instagram_removal_uncertain', 'worker');
    return item;
  });
  if (!job) return false;
  // A reserva já foi gravada antes da chamada pública. Uma queda não dispara outro DELETE.
  if (job.removal_state === 'sending') return true;
  let state = 'deleted';
  let errorCode: string | null = null;
  try {
    await graph.removePublishedMedia(job.account_id, job.provider_id);
  } catch (error) {
    state = error instanceof MetaCommentError && !error.uncertain ? 'failed' : 'uncertain';
    errorCode = error instanceof MetaCommentError ? error.code : 'publisher_removal_receipt_unknown';
  }
  await publisherTransaction(db, async client => {
    await client.query('SELECT id FROM ops.publisher_posts WHERE environment=$1 AND id=$2 FOR UPDATE', [environment, job.post_id]);
    const result = await client.query(`UPDATE ops.publisher_destinations SET removal_state=$4,removal_error=$5,removal_updated_at=now(),
      post_url=CASE WHEN $4='deleted' THEN NULL ELSE post_url END
      WHERE environment=$1 AND post_id=$2 AND platform='instagram' AND removal_attempt=$3
        AND removal_state IN ('sending','uncertain')`, [environment, job.post_id, job.removal_attempt, state, errorCode]);
    if (result.rowCount) await publisherEvent(client, environment, job.post_id, 'instagram_removal_' + state,
      'worker', { provider_id: job.provider_id, error: errorCode });
  });
  return true;
}

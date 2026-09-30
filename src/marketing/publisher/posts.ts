import type { Pool, PoolClient } from 'pg';
import { accountId, PublisherError, type Draft, type Environment, type Destination } from './model.js';
import type { Media } from './media.js';
import { validateDestinationMedia } from './media-validation.js';

export interface Post {
  id: string;
  media_id: string | null;
  title: string;
  caption: string;
  destinations: Destination[];
  status: string;
  version: number;
  scheduled_at: Date | null;
  delete_after_publish: boolean;
  created_at: Date;
  updated_at: Date;
}
export async function publisherEvent(client: PoolClient, environment: Environment, postId: string,
  event: string, actor: string, payload: unknown = {}) {
  await client.query(`INSERT INTO ops.publisher_events(environment,post_id,event,actor,payload)
    VALUES($1,$2,$3,$4,$5)`, [environment, postId, event, actor, JSON.stringify(payload)]);
}
export async function saveDraft(pool: Pool, environment: Environment, id: string, data: Draft, actor: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const prior = (await client.query<Post>(
      'SELECT * FROM ops.publisher_posts WHERE environment=$1 AND id=$2 FOR UPDATE', [environment, id])).rows[0];
    if ((prior && (prior.status !== 'draft' || prior.version !== data.version)) || (!prior && data.version !== 0)) {
      throw new PublisherError('publisher_version_conflict');
    }
    if (data.media_id) {
      const media = (await client.query<Media>(
        'SELECT * FROM ops.publisher_media WHERE environment=$1 AND id=$2 FOR UPDATE', [environment, data.media_id])).rows[0];
      if (!media || media.status !== 'ready') throw new PublisherError('publisher_media_not_ready');
    }
    const result = await client.query<Post>(`INSERT INTO ops.publisher_posts
      (environment,id,media_id,title,caption,destinations,delete_after_publish,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(environment,id) DO UPDATE SET
      media_id=excluded.media_id,title=excluded.title,caption=excluded.caption,destinations=excluded.destinations,
      delete_after_publish=excluded.delete_after_publish,version=ops.publisher_posts.version+1,updated_at=now() RETURNING *`,
    [environment, id, data.media_id, data.title, data.caption, JSON.stringify(data.destinations), data.delete_after_publish, actor]);
    await publisherEvent(client, environment, id, 'draft_saved', actor);
    await client.query('COMMIT');
    return result.rows[0]!;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export async function submitPost(pool: Pool, environment: Environment, id: string, version: number,
  scheduledAt: string | null, actor: string, now = new Date()) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const post = (await client.query<Post>(
      'SELECT * FROM ops.publisher_posts WHERE environment=$1 AND id=$2 FOR UPDATE', [environment, id])).rows[0];
    if (!post) throw new PublisherError('publisher_post_not_found', 404);
    // Uma resposta perdida pode ser consultada sem repetir a mesma publicação.
    if (post.status !== 'draft') {
      if (post.version === version + 1 && ['scheduled', 'publishing', 'published', 'partial', 'failed'].includes(post.status)) {
        await client.query('COMMIT');
        return post;
      }
      throw new PublisherError('publisher_version_conflict');
    }
    if (post.version !== version) throw new PublisherError('publisher_version_conflict');
    const media = (await client.query<Media>(
      'SELECT * FROM ops.publisher_media WHERE environment=$1 AND id=$2 FOR UPDATE', [environment, post.media_id])).rows[0];
    if (!media || media.status !== 'ready') throw new PublisherError('publisher_media_not_ready');
    validateDestinationMedia(media, post.destinations);
    const date = scheduledAt ? new Date(scheduledAt) : now;
    if (!Number.isFinite(date.getTime()) || (scheduledAt && date.getTime() < now.getTime() + 60_000)
      || date.getTime() > now.getTime() + 180 * 86_400_000) {
      throw new PublisherError('publisher_schedule_invalid', 400);
    }
    for (const destination of post.destinations) {
      await client.query(`INSERT INTO ops.publisher_destinations
        (environment,post_id,platform,account_id,format,caption,next_attempt_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [environment, id, destination.platform, accountId(destination.platform), destination.format,
        destination.caption ?? post.caption, date]);
    }
    const updated = await client.query<Post>(`UPDATE ops.publisher_posts SET status=$3,scheduled_at=$4,
      version=version+1,updated_at=now() WHERE environment=$1 AND id=$2 RETURNING *`,
    [environment, id, scheduledAt ? 'scheduled' : 'publishing', date]);
    await publisherEvent(client, environment, id, scheduledAt ? 'scheduled' : 'submitted', actor,
      { scheduled_at: date.toISOString() });
    await client.query('COMMIT');
    return updated.rows[0]!;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export async function postAction(pool: Pool, environment: Environment, id: string,
  action: 'cancel' | 'retry', actor: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const post = (await client.query<Post>(
      'SELECT * FROM ops.publisher_posts WHERE environment=$1 AND id=$2 FOR UPDATE', [environment, id])).rows[0];
    if (!post) throw new PublisherError('publisher_post_not_found', 404);
    const destinations = (await client.query<{ status: string; platform: string }>(
      'SELECT status,platform FROM ops.publisher_destinations WHERE environment=$1 AND post_id=$2 FOR UPDATE', [environment, id])).rows;
    if (action === 'cancel') {
      if (post.status === 'cancelled') {
        await client.query('COMMIT');
        return { id };
      }
      if (post.status !== 'draft' && (destinations.some(d => d.status !== 'queued') || post.status !== 'scheduled')) {
        throw new PublisherError('publisher_already_started');
      }
      await client.query(`UPDATE ops.publisher_destinations SET status='cancelled' WHERE environment=$1 AND post_id=$2`,
        [environment, id]);
      await client.query(`UPDATE ops.publisher_posts SET status='cancelled',version=version+1,updated_at=now()
        WHERE environment=$1 AND id=$2`, [environment, id]);
    } else {
      if (!['failed', 'partial'].includes(post.status) || !destinations.some(d => d.status === 'failed')) {
        throw new PublisherError('publisher_retry_not_allowed');
      }
      const media = (await client.query<Media>(
        'SELECT * FROM ops.publisher_media WHERE environment=$1 AND id=$2 FOR UPDATE', [environment, post.media_id])).rows[0];
      if (media?.status !== 'ready') throw new PublisherError('publisher_media_not_ready');
      validateDestinationMedia(media, post.destinations.filter(destination =>
        destinations.some(item =>
          item.status === 'failed' && item.platform === destination.platform)));
      // Somente falhas definitivas. Destinos publicados ou incertos nunca são reenviados.
      await client.query(`UPDATE ops.publisher_destinations SET status='queued',container_id=NULL,provider_id=NULL,error_code=NULL,
        lease_id=NULL,lease_until=NULL,started_at=NULL,public_started_at=NULL,retry_attempts=0,next_attempt_at=now(),updated_at=now()
        WHERE environment=$1 AND post_id=$2 AND status='failed'`, [environment, id]);
      await client.query(`UPDATE ops.publisher_posts SET status='publishing',version=version+1,updated_at=now()
        WHERE environment=$1 AND id=$2`, [environment, id]);
    }
    await publisherEvent(client, environment, id, action, actor);
    await client.query('COMMIT');
    return { id };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export async function listPosts(pool: Pool, environment: Environment) {
  return (await pool.query(`SELECT p.*,m.name media_name,m.kind media_kind,
    coalesce((SELECT jsonb_agg(jsonb_build_object('platform',d.platform,'format',d.format,'status',d.status,
      'post_url',d.post_url,'error_code',d.error_code,'provider_id',d.provider_id,'container_id',d.container_id) ORDER BY d.platform)
      FROM ops.publisher_destinations d WHERE d.environment=p.environment AND d.post_id=p.id),'[]') deliveries
    FROM ops.publisher_posts p LEFT JOIN ops.publisher_media m ON m.environment=p.environment AND m.id=p.media_id
    WHERE p.environment=$1 ORDER BY p.updated_at DESC LIMIT 200`, [environment])).rows;
}

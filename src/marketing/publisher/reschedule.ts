import type { Pool } from 'pg';
import { PublisherError, type Environment } from './model.js';
import { publisherEvent, type Post } from './posts.js';

/** Usa o mesmo lock de publicação da fila; um destino iniciado nunca muda de horário. */
export async function reschedulePost(db: Pool, environment: Environment, id: string, version: number,
  scheduledAt: string, actor: string, now = new Date()) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const post = (await client.query<Post>(
      'SELECT * FROM ops.publisher_posts WHERE environment=$1 AND id=$2 FOR UPDATE', [environment, id])).rows[0];
    if (!post) throw new PublisherError('publisher_post_not_found', 404);
    const target = new Date(scheduledAt);
    // Recupera uma resposta perdida, inclusive se a fila já começou depois da alteração.
    if (post.version === version + 1 && post.scheduled_at && target.getTime() === new Date(post.scheduled_at).getTime()
      && ['scheduled', 'publishing', 'published', 'partial', 'failed'].includes(post.status)) {
      const repeated = await client.query(`SELECT 1 FROM ops.publisher_events WHERE environment=$1 AND post_id=$2
        AND event='rescheduled' AND payload->>'previous_version'=$3 AND payload->>'scheduled_at'=$4 LIMIT 1`,
      [environment, id, String(version), target.toISOString()]);
      if (repeated.rows.length) { await client.query('COMMIT'); return post; }
    }
    if (post.version !== version) throw new PublisherError('publisher_version_conflict');
    if (post.status !== 'scheduled') throw new PublisherError('publisher_already_started');
    if (!Number.isFinite(target.getTime()) || target.getTime() < now.getTime() + 60_000
      || target.getTime() > now.getTime() + 180 * 86_400_000) throw new PublisherError('publisher_schedule_invalid', 400);
    const destinations = (await client.query<{ status: string; lease_id: string | null; started_at: Date | null; public_started_at: Date | null }>(
      'SELECT status,lease_id,started_at,public_started_at FROM ops.publisher_destinations WHERE environment=$1 AND post_id=$2 FOR UPDATE',
      [environment, id])).rows;
    if (!destinations.length || destinations.some(d => d.status !== 'queued' || d.lease_id || d.started_at || d.public_started_at)) {
      throw new PublisherError('publisher_already_started');
    }
    await client.query(`UPDATE ops.publisher_destinations SET next_attempt_at=$3,updated_at=now()
      WHERE environment=$1 AND post_id=$2 AND status='queued'`, [environment, id, target.toISOString()]);
    const updated = (await client.query<Post>(`UPDATE ops.publisher_posts SET scheduled_at=$3,
      version=version+1,updated_at=now() WHERE environment=$1 AND id=$2 RETURNING *`,
    [environment, id, target.toISOString()])).rows[0]!;
    await publisherEvent(client, environment, id, 'rescheduled', actor,
      { previous_version: version, previous_scheduled_at: post.scheduled_at, scheduled_at: target.toISOString() });
    await client.query('COMMIT'); return updated;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

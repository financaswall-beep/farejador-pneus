import type { PoolClient } from 'pg';
import type { Media } from './media.js';
import { PublisherError, type Destination, type Environment } from './model.js';
import { validateDestinationMedia } from './media-validation.js';

/** Inclui a capa já armazenada pela versão anterior, seguida das outras fotos em ordem. */
export const postMediaIdsSql = `array_remove(ARRAY[p.media_id], NULL) || ARRAY(
  SELECT f.media_id FROM ops.publisher_post_photos f WHERE f.environment=p.environment AND f.post_id=p.id
  ORDER BY f.position)`;

export async function validatePostMedia(db: PoolClient, environment: Environment, ids: string[],
  destinations: Destination[], submitting: boolean) {
  if (!ids.length) {
    if (submitting) throw new PublisherError('publisher_media_not_ready');
    return;
  }
  const rows = (await db.query<Media>(`SELECT * FROM ops.publisher_media WHERE environment=$1
    AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE`, [environment, ids])).rows;
  if (rows.length !== ids.length || rows.some(m => m.status !== 'ready')) throw new PublisherError('publisher_media_not_ready');
  if (ids.length > 1 && (rows.some(m => m.kind !== 'photo') || destinations.some(d => d.format !== 'feed'))) {
    throw new PublisherError('publisher_carousel_photos_feed', 400);
  }
  if (submitting) for (const media of rows) validateDestinationMedia(media, destinations);
}

import type { Pool } from 'pg';
import { PublisherError, type Environment } from './model.js';
import type { Media } from './media.js';
import { PublisherStorage } from './storage.js';

export async function deleteMedia(pool:Pool,environment:Environment,id:string,automatic:boolean,storage=new PublisherStorage()):Promise<boolean> {
  const client=await pool.connect();let media:Media|undefined;
  try {
    await client.query('BEGIN');
    media=(await client.query<Media>('SELECT * FROM ops.publisher_media WHERE environment=$1 AND id=$2 FOR UPDATE',[environment,id])).rows[0];
    if(!media)throw new PublisherError('publisher_media_not_found',404);
    if(media.status==='deleted'){await client.query('COMMIT');return true;}
    if(!automatic && media.status==='uploading' && !(await client.query(`SELECT 1 FROM ops.publisher_media
      WHERE environment=$1 AND id=$2 AND created_at<now()-interval '3 hours'`,[environment,id])).rowCount) {
      throw new PublisherError('publisher_upload_active');
    }
    const references=await client.query<{id:string}>(`SELECT p.id FROM ops.publisher_posts p WHERE p.environment=$1 AND p.media_id=$2 AND
      (p.status NOT IN ('published','cancelled') OR ($3::boolean AND p.status='published' AND NOT p.delete_after_publish) OR EXISTS (SELECT 1 FROM ops.publisher_destinations d
        WHERE d.environment=p.environment AND d.post_id=p.id AND d.status<>'published' AND p.status<>'cancelled'))`,[environment,id,automatic]);
    if(references.rowCount){
      if(!automatic)throw new PublisherError('publisher_media_in_use');
      await client.query('COMMIT');return false;
    }
    if(automatic && media.status!=='deleting') {
      const qualifies=await client.query(`SELECT 1 FROM ops.publisher_posts WHERE environment=$1 AND media_id=$2
        AND status='published' AND delete_after_publish`,[environment,id]);
      const orphan=(media.status==='uploading' || media.status==='failed') && Boolean((await client.query(`SELECT 1 FROM ops.publisher_media
        WHERE environment=$1 AND id=$2 AND created_at<now()-interval '3 hours'`,[environment,id])).rowCount);
      if(!qualifies.rowCount && !orphan){await client.query('COMMIT');return false;}
    }
    await client.query(`UPDATE ops.publisher_media SET status='deleting' WHERE environment=$1 AND id=$2`,[environment,id]);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  // O estado deleting bloqueia novos rascunhos enquanto o Storage é limpo. Miniatura leve preservada.
  await storage.remove([media!.original_path,...(media!.kind==='photo'?[`${environment}/${id}/publish.jpg`]:[]),
    ...(media!.publish_path?[media!.publish_path]:[]),...(!media!.thumbnail_path?[`${environment}/${id}/thumbnail.jpg`]:[])]);
  await pool.query(`UPDATE ops.publisher_media SET status='deleted',deleted_at=now() WHERE environment=$1 AND id=$2 AND status='deleting'`,[environment,id]);
  return true;
}
export async function cleanupMedia(pool:Pool,environment:Environment,storage=new PublisherStorage()) {
  const ids=(await pool.query<{id:string}>(`SELECT m.id FROM ops.publisher_media m WHERE m.environment=$1 AND
    (m.status='deleting' OR m.status IN ('uploading','failed') AND m.created_at<now()-interval '3 hours'
      OR m.status='ready' AND EXISTS(SELECT 1 FROM ops.publisher_posts p WHERE p.environment=m.environment
        AND p.media_id=m.id AND p.status='published' AND p.delete_after_publish)) LIMIT 20`,[environment])).rows;
  for(const {id} of ids)await deleteMedia(pool,environment,id,true,storage);
}

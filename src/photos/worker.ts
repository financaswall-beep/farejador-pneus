import { pool } from '../persistence/db.js';
import { env } from '../shared/config/env.js';
import { logger } from '../shared/logger.js';
import { migrateOnePhoto,processPhotoUpload,removeOneTemporaryPhoto } from './process.js';
import { purgeOneClosedPhotoRequest } from './retention.js';
import { photoStorageConfigured,TirePhotoStorage } from './storage.js';

/** Mesmo processo/container. Sem concorrência de codecs; lock também cobre múltiplas réplicas. */
export function startTirePhotoWorker() {
  if (!env.PHOTO_REQUESTS) return ()=>undefined;
  const storage=new TirePhotoStorage();
  let stopped=false,running=false,bucketReady=false,round=0;
  async function tick() {
    if (running || stopped) return;
    running=true;
    try {
      if (photoStorageConfigured() && !bucketReady) { await storage.ensureBucket(); bucketReady=true; }
      const client=await pool.connect();
      try {
        await client.query('BEGIN');
        const locked=await client.query<{ ok:boolean }>(`SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok`,
          [`tire-photo-worker:${env.FAREJADOR_ENV}`]);
        if (locked.rows[0]?.ok) {
          // Manutenção tem vez mesmo com fila contínua de novos uploads.
          round++;
          if (round%10===0) {
            await purgeOneClosedPhotoRequest(client,env.FAREJADOR_ENV,storage);
            if (photoStorageConfigured()) await removeOneTemporaryPhoto(client,env.FAREJADOR_ENV,storage);
          } else {
            const worked=photoStorageConfigured() && await processPhotoUpload(client,env.FAREJADOR_ENV,storage);
            if (!worked) await migrateOnePhoto(client,env.FAREJADOR_ENV,storage);
          }
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        const uploadId=(error as { photoUploadId?:string }).photoUploadId;
        if (uploadId) await client.query(`UPDATE commerce.photo_uploads SET attempts=attempts+1,updated_at=now()
          WHERE id=$1 AND environment=$2 AND state='queued'`,[uploadId,env.FAREJADOR_ENV]);
        throw error;
      } finally { client.release(); }
    } catch (error) { logger.error({ err:error },'tire photo worker failed; retained for retry'); }
    finally { running=false; }
  }
  const timer=setInterval(()=>void tick(),2000);
  void tick();
  return ()=>{ stopped=true;clearInterval(timer); };
}

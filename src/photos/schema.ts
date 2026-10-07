import type { Pool } from 'pg';
export async function assertTirePhotoSchema(db: Pick<Pool,'query'>) {
  const result=await db.query<{ ready:boolean }>(`SELECT
    to_regclass('commerce.photo_uploads') IS NOT NULL
    AND to_regclass('commerce.tire_photo_retention') IS NOT NULL
    AND EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema='commerce' AND table_name='photo_request_blobs' AND column_name='storage_path') AS ready`);
  if (result.rows[0]?.ready!==true) throw new Error('required_schema_missing:0270_tire_photo_storage_retention');
}

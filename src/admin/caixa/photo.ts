import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';

export interface CaixaPhotoQueueItem {
  id: string;
  tire_size: string;
  brand: string | null;
  note: string | null;
  customer_name: string | null;
  expires_at: string;
  created_at: string;
}

export async function getCaixaMainUnitId(
  environment: 'prod' | 'test',
  dbPool: Pool = defaultPool,
): Promise<string | null> {
  const result = await dbPool.query<{ id: string }>(
    `SELECT id FROM core.units WHERE environment=$1 AND slug='main' LIMIT 1`,
    [environment],
  );
  return result.rows[0]?.id ?? null;
}

/** Fila mínima da Matriz. Nunca projeta conversation_id, telefone ou bytes. */
export async function getCaixaPhotoQueue(
  environment: 'prod' | 'test',
  dbPool: Pool = defaultPool,
): Promise<CaixaPhotoQueueItem[]> {
  const result = await dbPool.query<CaixaPhotoQueueItem>(
    `SELECT pr.id,pr.tire_size,pr.brand,pr.note,
            pr.customer_label AS customer_name,pr.expires_at,pr.created_at
       FROM commerce.photo_requests pr
       JOIN core.units u
         ON u.id=pr.unit_id AND u.environment=pr.environment AND u.slug='main'
      WHERE pr.environment=$1 AND pr.status='pending' AND pr.expires_at>now()
      ORDER BY pr.created_at
      LIMIT 20`,
    [environment],
  );
  return result.rows;
}

export interface AttachCaixaPhotoResult {
  status: 'ok' | 'not_found' | 'rejected';
  state?: string;
  was_late?: boolean;
  attached?: boolean;
}

/**
 * Trava e prova que o pedido pertence à unidade main antes de reutilizar a
 * função atômica de anexo. A checagem e a função rodam na mesma transação.
 */
export async function attachCaixaPhoto(
  environment: 'prod' | 'test',
  photoRequestId: string,
  photo: { bytes: Buffer; mime: string; sizeBytes: number },
  dbPool: Pool = defaultPool,
): Promise<AttachCaixaPhotoResult> {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const owned = await client.query<{ id: string }>(
      `SELECT pr.id
         FROM commerce.photo_requests pr
         JOIN core.units u
           ON u.id=pr.unit_id AND u.environment=pr.environment AND u.slug='main'
        WHERE pr.id=$2 AND pr.environment=$1
        FOR UPDATE OF pr`,
      [environment, photoRequestId],
    );
    if (owned.rowCount !== 1) {
      await client.query('ROLLBACK');
      return { status: 'not_found' };
    }
    const result = await client.query<{
      out_status: string;
      out_was_late: boolean;
      out_attached: boolean;
    }>(
      'SELECT out_status,out_was_late,out_attached FROM commerce.attach_partner_photo($1,$2,$3,$4)',
      [photoRequestId, photo.bytes, photo.mime, photo.sizeBytes],
    );
    await client.query('COMMIT');
    const row = result.rows[0];
    if (!row) return { status: 'not_found' };
    return {
      status: 'ok',
      state: row.out_status,
      was_late: row.out_was_late,
      attached: row.out_attached,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if ((error as { code?: string }).code === '23514') return { status: 'rejected' };
    throw error;
  } finally {
    client.release();
  }
}

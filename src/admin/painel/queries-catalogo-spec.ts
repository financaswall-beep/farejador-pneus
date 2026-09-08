import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';

export interface UpdateCatalogTireSpecInput {
  productId: string;
  treadPattern?: string | null;
  loadIndex?: string | null;
  speedRating?: string | null;
  position?: 'front' | 'rear' | 'both' | null;
  reason: string;
  actorLabel: string;
  environment?: 'prod' | 'test';
}

interface TireSpecSnapshot {
  id: string;
  tread_pattern: string | null;
  load_index: string | null;
  speed_rating: string | null;
  position: 'front' | 'rear' | 'both' | null;
}

function optionalText(value: string | null | undefined): string | null {
  return value?.trim().replace(/\s+/g, ' ') || null;
}

export async function updateCatalogTireSpec(
  input: UpdateCatalogTireSpecInput,
  dbPool: Pool = defaultPool,
): Promise<{ changed: boolean; spec: TireSpecSnapshot }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const reason = input.reason.trim();
  if (reason.length < 2 || reason.length > 500) {
    throw new Error('catalog_spec_reason_required');
  }
  const next = {
    tread_pattern: optionalText(input.treadPattern),
    load_index: optionalText(input.loadIndex),
    speed_rating: optionalText(input.speedRating)?.toUpperCase() ?? null,
    position: input.position ?? null,
  };

  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query<TireSpecSnapshot>(
      `SELECT ts.id,ts.tread_pattern,ts.load_index,ts.speed_rating,ts.position
         FROM commerce.products p
         JOIN commerce.tire_specs ts
           ON ts.product_id=p.id AND ts.environment=p.environment
        WHERE p.environment=$1 AND p.id=$2 AND p.product_type='tire'
          AND p.deleted_at IS NULL
        FOR UPDATE OF p,ts`,
      [environment, input.productId],
    );
    const before = current.rows[0];
    if (!before) throw new Error('catalog_product_not_found');
    const changed = before.tread_pattern !== next.tread_pattern
      || before.load_index !== next.load_index
      || before.speed_rating !== next.speed_rating
      || before.position !== next.position;
    if (!changed) {
      await client.query('COMMIT');
      return { changed: false, spec: before };
    }

    const updated = await client.query<TireSpecSnapshot>(
      `UPDATE commerce.tire_specs
          SET tread_pattern=$3,load_index=$4,speed_rating=$5,position=$6,updated_at=now()
        WHERE environment=$1 AND id=$2
        RETURNING id,tread_pattern,load_index,speed_rating,position`,
      [environment, before.id, next.tread_pattern, next.load_index,
       next.speed_rating, next.position],
    );
    const spec = updated.rows[0]!;
    await client.query(
      `INSERT INTO audit.events
         (environment,domain,entity_table,entity_id,event_type,actor_label,
          payload_before,payload_after)
       VALUES ($1,'catalog','commerce.tire_specs',$2,'catalog_tire_spec_changed',
               $3,$4::jsonb,$5::jsonb)`,
      [environment, before.id, input.actorLabel.trim().slice(0, 120) || 'admin',
       JSON.stringify(before), JSON.stringify({ ...spec, product_id: input.productId, reason })],
    );
    await client.query('COMMIT');
    return { changed: true, spec };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

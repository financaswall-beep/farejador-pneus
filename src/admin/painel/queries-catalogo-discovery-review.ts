import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { loadCatalogMeasureSpecs } from './queries-catalogo-compatibilidade.js';

export interface ReviewFitmentDiscoveryInput {
  productId: string;
  discoveryId: string;
  decision: 'approve' | 'reject';
  reason: string;
  actorLabel: string;
  environment?: 'prod' | 'test';
}
export async function reviewCatalogFitmentDiscovery(
  input: ReviewFitmentDiscoveryInput,
  dbPool: Pool = defaultPool,
): Promise<{ status: 'promoted' | 'rejected'; fitments_promoted: number }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const reason = input.reason.trim();
  if (reason.length < 2 || reason.length > 500) throw new Error('catalog_discovery_review_reason_required');
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const { tireSize, tireSpecIds } = await loadCatalogMeasureSpecs(client, environment, input.productId);
    const discovery = await client.query<{
      id: string; vehicle_model_id: string; tire_spec_id: string;
      position: 'front' | 'rear' | 'both'; status: string;
      suggested_is_oem: boolean; suggested_confidence_level: string | null;
      discovery_measure: string;
    }>(
      `SELECT d.id,d.vehicle_model_id,d.tire_spec_id,d.position,d.status,
              d.suggested_is_oem,d.suggested_confidence_level,
              ts.tire_size discovery_measure
         FROM commerce.fitment_discoveries d
         JOIN commerce.tire_specs ts
           ON ts.id=d.tire_spec_id AND ts.environment=d.environment
        WHERE d.environment=$1 AND d.id=$2 FOR UPDATE OF d`,
      [environment, input.discoveryId],
    );
    const candidate = discovery.rows[0];
    if (!candidate) throw new Error('catalog_discovery_not_found');
    if (candidate.discovery_measure.replace(/\D/g, '') !== tireSize.replace(/\D/g, '')) {
      throw new Error('catalog_discovery_measure_mismatch');
    }
    if (candidate.status !== 'pending' && candidate.status !== 'approved') {
      throw new Error('catalog_discovery_already_reviewed');
    }
    const actor = input.actorLabel.trim().slice(0, 120) || 'admin';
    if (input.decision === 'reject') {
      await client.query(
        `UPDATE commerce.fitment_discoveries
            SET status='rejected',reviewed_by=$3,reviewed_at=now(),notes=$4
          WHERE environment=$1 AND id=$2`,
        [environment, input.discoveryId, actor, reason],
      );
      await client.query(
        `INSERT INTO audit.events
           (environment,domain,entity_table,entity_id,event_type,actor_label,payload_before,payload_after)
         VALUES ($1,'catalog','commerce.fitment_discoveries',$2,'catalog_fitment_candidate_rejected',$3,$4::jsonb,$5::jsonb)`,
        [environment, input.discoveryId, actor, JSON.stringify({ status: candidate.status }),
         JSON.stringify({ status: 'rejected', reason })],
      );
      await client.query('COMMIT');
      return { status: 'rejected', fitments_promoted: 0 };
    }

    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `catalog-fitment:${environment}:${tireSize.replace(/\D/g, '')}:${candidate.vehicle_model_id}:${candidate.position}`,
    ]);
    const promoted = await client.query<{ id: string }>(
      `INSERT INTO commerce.vehicle_fitments
         (environment,vehicle_model_id,tire_spec_id,position,is_oem,source,confidence_level)
       SELECT $1::env_t,$2,spec_id,$3,$4,'discovery_promoted',$5
         FROM unnest($6::uuid[]) AS spec_id
       ON CONFLICT (environment,vehicle_model_id,tire_spec_id,position)
       DO UPDATE SET is_oem=EXCLUDED.is_oem,source=EXCLUDED.source,
                     confidence_level=EXCLUDED.confidence_level,updated_at=now()
       RETURNING id`,
      [environment, candidate.vehicle_model_id, candidate.position,
       candidate.suggested_is_oem,
       candidate.suggested_confidence_level === null
         ? 0.8 : Number(candidate.suggested_confidence_level), tireSpecIds],
    );
    const fitmentIds = promoted.rows.map((row) => row.id);
    await client.query(
      `UPDATE commerce.fitment_discoveries
          SET status='promoted',reviewed_by=$3,reviewed_at=now(),
              promoted_to_fitment_id=$4,notes=$5
        WHERE environment=$1 AND id=$2`,
      [environment, input.discoveryId, actor, fitmentIds[0], reason],
    );
    await client.query(
      `INSERT INTO commerce.fitment_discovery_promotions
         (environment,discovery_id,fitment_id)
       SELECT $1::env_t,$2,fitment_id FROM unnest($3::uuid[]) fitment_id
       ON CONFLICT (environment,discovery_id,fitment_id) DO NOTHING`,
      [environment, input.discoveryId, fitmentIds],
    );
    await client.query(
      `INSERT INTO audit.events
         (environment,domain,entity_table,entity_id,event_type,actor_label,payload_before,payload_after)
       VALUES ($1,'catalog','commerce.fitment_discoveries',$2,'catalog_fitment_candidate_promoted',$3,$4::jsonb,$5::jsonb)`,
      [environment, input.discoveryId, actor, JSON.stringify({ status: candidate.status }),
       JSON.stringify({ status: 'promoted', reason, tire_size: tireSize,
         fitment_ids: fitmentIds, affected_tire_specs: tireSpecIds.length })],
    );
    await client.query('COMMIT');
    return { status: 'promoted', fitments_promoted: fitmentIds.length };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

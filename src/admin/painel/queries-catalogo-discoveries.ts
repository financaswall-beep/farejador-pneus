import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import {
  loadCatalogMeasureSpecs,
  type CatalogVehicleModelRow,
} from './queries-catalogo-compatibilidade.js';

export interface CatalogFitmentDiscoveryRow extends CatalogVehicleModelRow {
  discovery_id: string;
  position: 'front' | 'rear' | 'both';
  status: 'pending' | 'approved' | 'rejected' | 'promoted';
  discovery_origin: 'conversation' | 'web_research' | 'manual';
  source_url: string | null;
  source_title: string | null;
  source_checked_at: string | null;
  evidence_summary: string | null;
  suggested_is_oem: boolean;
  suggested_confidence_level: string | null;
  discovered_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  notes: string | null;
}

export async function getCatalogFitmentDiscoveries(
  productId: string,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<CatalogFitmentDiscoveryRow[]> {
  const result = await dbPool.query<CatalogFitmentDiscoveryRow>(
    `WITH selected AS (
       SELECT regexp_replace(ts.tire_size,'[^0-9]+','','g') measure_key
         FROM commerce.products p
         JOIN commerce.tire_specs ts
           ON ts.product_id=p.id AND ts.environment=p.environment
        WHERE p.environment=$1 AND p.id=$2 AND p.deleted_at IS NULL
          AND p.product_type='tire'
     )
     SELECT d.id discovery_id,d.position,d.status,d.discovery_origin,
            d.source_url,d.source_title,d.source_checked_at,d.evidence_summary,
            d.suggested_is_oem,d.suggested_confidence_level,d.discovered_at,
            d.reviewed_by,d.reviewed_at,d.notes,
            vm.id vehicle_model_id,vm.make,vm.model,vm.variant,
            vm.year_start,vm.year_end,vm.displacement_cc
       FROM commerce.fitment_discoveries d
       JOIN commerce.tire_specs ts
         ON ts.id=d.tire_spec_id AND ts.environment=d.environment
       JOIN commerce.vehicle_models vm
         ON vm.id=d.vehicle_model_id AND vm.environment=d.environment
       JOIN selected s
         ON s.measure_key=regexp_replace(ts.tire_size,'[^0-9]+','','g')
      WHERE d.environment=$1
      ORDER BY CASE d.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1
                 WHEN 'promoted' THEN 2 ELSE 3 END,d.discovered_at DESC`,
    [environment, productId],
  );
  if (!result.rows.length) {
    const product = await dbPool.query(
      `SELECT 1 FROM commerce.products
        WHERE environment=$1 AND id=$2 AND deleted_at IS NULL`,
      [environment, productId],
    );
    if (!product.rows[0]) throw new Error('catalog_product_not_found');
  }
  return result.rows;
}

export interface CreateFitmentDiscoveryInput {
  productId: string;
  vehicleModelId: string;
  position: 'front' | 'rear' | 'both';
  sourceUrl: string;
  sourceTitle?: string | null;
  evidenceSummary: string;
  suggestedIsOem: boolean;
  confidenceLevel: number;
  actorLabel: string;
  environment?: 'prod' | 'test';
}

export async function createCatalogFitmentDiscovery(
  input: CreateFitmentDiscoveryInput,
  dbPool: Pool = defaultPool,
): Promise<{ discovery_id: string; status: 'pending' }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  let sourceUrl: URL;
  try {
    sourceUrl = new URL(input.sourceUrl.trim());
  } catch {
    throw new Error('catalog_discovery_source_url_invalid');
  }
  if (!['http:', 'https:'].includes(sourceUrl.protocol)) {
    throw new Error('catalog_discovery_source_url_invalid');
  }
  const summary = input.evidenceSummary.trim();
  if (summary.length < 5 || summary.length > 2000) {
    throw new Error('catalog_discovery_evidence_invalid');
  }
  if (!Number.isFinite(input.confidenceLevel) || input.confidenceLevel < 0
    || input.confidenceLevel > 1) throw new Error('catalog_compatibility_confidence_invalid');
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const { tireSize, tireSpecIds } = await loadCatalogMeasureSpecs(client, environment, input.productId);
    const vehicle = await client.query(
      `SELECT id FROM commerce.vehicle_models
        WHERE environment=$1 AND id=$2 AND vehicle_type='motorcycle'
          AND deleted_at IS NULL FOR UPDATE`,
      [environment, input.vehicleModelId],
    );
    if (!vehicle.rows[0]) throw new Error('catalog_vehicle_model_not_found');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `catalog-discovery:${environment}:${tireSize.replace(/\D/g, '')}:${input.vehicleModelId}:${input.position}`,
    ]);
    const duplicate = await client.query<{ id: string }>(
      `SELECT d.id
         FROM commerce.fitment_discoveries d
        WHERE d.environment=$1 AND d.vehicle_model_id=$2 AND d.position=$3
          AND d.tire_spec_id=ANY($4::uuid[]) AND d.status IN ('pending','approved')
        LIMIT 1 FOR UPDATE`,
      [environment, input.vehicleModelId, input.position, tireSpecIds],
    );
    if (duplicate.rows[0]) throw new Error('catalog_discovery_already_pending');
    const created = await client.query<{ id: string }>(
      `INSERT INTO commerce.fitment_discoveries
         (environment,vehicle_model_id,tire_spec_id,position,status,discovery_origin,
          source_url,source_title,source_checked_at,evidence_summary,
          suggested_is_oem,suggested_confidence_level,notes)
       VALUES ($1,$2,$3,$4,'pending','web_research',$5,$6,now(),$7,$8,$9,$10)
       RETURNING id`,
      [environment, input.vehicleModelId, tireSpecIds[0], input.position,
       sourceUrl.toString(), input.sourceTitle?.trim().slice(0, 300) || null,
       summary, input.suggestedIsOem, input.confidenceLevel,
       `Registrado por ${input.actorLabel.trim().slice(0, 120) || 'admin'}`],
    );
    const discoveryId = created.rows[0]!.id;
    await client.query(
      `INSERT INTO audit.events
         (environment,domain,entity_table,entity_id,event_type,actor_label,payload_after)
       VALUES ($1,'catalog','commerce.fitment_discoveries',$2,'catalog_fitment_candidate_created',$3,$4::jsonb)`,
      [environment, discoveryId, input.actorLabel.trim().slice(0, 120) || 'admin',
       JSON.stringify({ product_id: input.productId, tire_size: tireSize,
         vehicle_model_id: input.vehicleModelId, position: input.position,
         source_url: sourceUrl.toString(), evidence_summary: summary,
         status: 'pending', automatic_promotion: false })],
    );
    await client.query('COMMIT');
    return { discovery_id: discoveryId, status: 'pending' };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export * from './queries-catalogo-discovery-review.js';

import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import type { TireCondition } from '../../shared/tire-condition.js';

export interface CatalogCompatibilityRow {
  vehicle_model_id: string;
  make: string;
  model: string;
  variant: string | null;
  year_start: number | null;
  year_end: number | null;
  position: 'front' | 'rear' | 'both';
  is_oem: boolean;
  source: 'manufacturer' | 'manual' | 'discovery_promoted';
  confidence_level: string | null;
}

export interface CatalogVehicleModelRow {
  vehicle_model_id: string;
  make: string;
  model: string;
  variant: string | null;
  year_start: number | null;
  year_end: number | null;
  displacement_cc: number | null;
}

interface CompatibilityMutationInput {
  productId: string;
  vehicleModelId: string;
  position: 'front' | 'rear' | 'both';
  reason: string;
  actorLabel: string;
  environment?: 'prod' | 'test';
}

export interface AddCompatibilityInput extends CompatibilityMutationInput {
  isOem: boolean;
  source: 'manufacturer' | 'manual';
  confidenceLevel: number;
}

export async function searchCatalogVehicleModels(
  term: string,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<CatalogVehicleModelRow[]> {
  const query = term.trim();
  if (query.length < 2) return [];
  const result = await dbPool.query<CatalogVehicleModelRow>(
    `SELECT id AS vehicle_model_id,make,model,variant,year_start,year_end,displacement_cc
       FROM commerce.vehicle_models
      WHERE environment=$1 AND vehicle_type='motorcycle' AND deleted_at IS NULL
        AND (make ILIKE $2 OR model ILIKE $2 OR COALESCE(variant,'') ILIKE $2
          OR COALESCE(aliases::text,'') ILIKE $2
          OR concat_ws(' ',make,model,variant,displacement_cc::text) ILIKE $2)
      ORDER BY
        CASE WHEN lower(model)=lower($3) THEN 0
             WHEN lower(model) LIKE lower($3) || '%' THEN 1 ELSE 2 END,
        make,model,variant NULLS FIRST,year_start NULLS FIRST
      LIMIT 30`,
    [environment, `%${query}%`, query],
  );
  return result.rows;
}

export async function loadCatalogMeasureSpecs(
  client: PoolClient,
  environment: 'prod' | 'test',
  productId: string,
): Promise<{ tireSize: string; tireSpecIds: string[] }> {
  const selected = await client.query<{ tire_size: string }>(
    `SELECT ts.tire_size
       FROM commerce.products p
       JOIN commerce.tire_specs ts
         ON ts.product_id=p.id AND ts.environment=p.environment
      WHERE p.environment=$1 AND p.id=$2 AND p.product_type='tire'
        AND p.deleted_at IS NULL
      LIMIT 1 FOR UPDATE OF p`,
    [environment, productId],
  );
  if (!selected.rows[0]) throw new Error('catalog_product_not_found');
  const tireSize = selected.rows[0].tire_size;
  const specs = await client.query<{ id: string }>(
    `SELECT ts.id
       FROM commerce.tire_specs ts
       JOIN commerce.products p
         ON p.id=ts.product_id AND p.environment=ts.environment
      WHERE ts.environment=$1 AND p.deleted_at IS NULL AND p.product_type='tire'
        AND regexp_replace(ts.tire_size,'[^0-9]+','','g')
            =regexp_replace($2,'[^0-9]+','','g')
      ORDER BY ts.id FOR UPDATE OF ts`,
    [environment, tireSize],
  );
  return { tireSize, tireSpecIds: specs.rows.map((row) => row.id) };
}

export async function addCatalogCompatibility(
  input: AddCompatibilityInput,
  dbPool: Pool = defaultPool,
): Promise<{ changed: boolean; fitments_created: number; tire_size: string }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const reason = input.reason.trim();
  if (reason.length < 2 || reason.length > 500) throw new Error('catalog_compatibility_reason_required');
  if (!Number.isFinite(input.confidenceLevel) || input.confidenceLevel < 0
    || input.confidenceLevel > 1) throw new Error('catalog_compatibility_confidence_invalid');
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const { tireSize, tireSpecIds } = await loadCatalogMeasureSpecs(client, environment, input.productId);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `catalog-fitment:${environment}:${tireSize.replace(/\D/g, '')}:${input.vehicleModelId}:${input.position}`,
    ]);
    const vehicle = await client.query<{ id: string; make: string; model: string }>(
      `SELECT id,make,model FROM commerce.vehicle_models
        WHERE environment=$1 AND id=$2 AND vehicle_type='motorcycle'
          AND deleted_at IS NULL FOR UPDATE`,
      [environment, input.vehicleModelId],
    );
    if (!vehicle.rows[0]) throw new Error('catalog_vehicle_model_not_found');
    const inserted = await client.query(
      `INSERT INTO commerce.vehicle_fitments
         (environment,vehicle_model_id,tire_spec_id,position,is_oem,source,confidence_level)
       SELECT $1::env_t,$2,spec_id,$3,$4,$5,$6
         FROM unnest($7::uuid[]) AS spec_id
       ON CONFLICT (environment,vehicle_model_id,tire_spec_id,position)
       DO UPDATE SET is_oem=EXCLUDED.is_oem,source=EXCLUDED.source,
                     confidence_level=EXCLUDED.confidence_level,updated_at=now()
       WHERE commerce.vehicle_fitments.is_oem IS DISTINCT FROM EXCLUDED.is_oem
          OR commerce.vehicle_fitments.source IS DISTINCT FROM EXCLUDED.source
          OR commerce.vehicle_fitments.confidence_level IS DISTINCT FROM EXCLUDED.confidence_level`,
      [environment, input.vehicleModelId, input.position, input.isOem, input.source,
       input.confidenceLevel, tireSpecIds],
    );
    await client.query(
      `INSERT INTO audit.events
         (environment,domain,entity_table,entity_id,event_type,actor_label,payload_after)
       VALUES ($1,'catalog','commerce.products',$2,'catalog_measure_fitment_saved',$3,$4::jsonb)`,
      [environment, input.productId, input.actorLabel.trim().slice(0, 120) || 'admin',
       JSON.stringify({ tire_size: tireSize, vehicle_model_id: input.vehicleModelId,
         vehicle: vehicle.rows[0], position: input.position, is_oem: input.isOem,
         source: input.source, confidence_level: input.confidenceLevel, reason,
         affected_tire_specs: tireSpecIds.length, changed_rows: inserted.rowCount ?? 0 })],
    );
    await client.query('COMMIT');
    return { changed: (inserted.rowCount ?? 0) > 0,
      fitments_created: inserted.rowCount ?? 0, tire_size: tireSize };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function removeCatalogCompatibility(
  input: CompatibilityMutationInput,
  dbPool: Pool = defaultPool,
): Promise<{ changed: boolean; fitments_removed: number; tire_size: string }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const reason = input.reason.trim();
  if (reason.length < 2 || reason.length > 500) throw new Error('catalog_compatibility_reason_required');
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const { tireSize, tireSpecIds } = await loadCatalogMeasureSpecs(client, environment, input.productId);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `catalog-fitment:${environment}:${tireSize.replace(/\D/g, '')}:${input.vehicleModelId}:${input.position}`,
    ]);
    const removed = await client.query(
      `DELETE FROM commerce.vehicle_fitments
        WHERE environment=$1 AND vehicle_model_id=$2 AND position=$3
          AND tire_spec_id=ANY($4::uuid[])`,
      [environment, input.vehicleModelId, input.position, tireSpecIds],
    );
    await client.query(
      `INSERT INTO audit.events
         (environment,domain,entity_table,entity_id,event_type,actor_label,payload_before,payload_after)
       VALUES ($1,'catalog','commerce.products',$2,'catalog_measure_fitment_removed',$3,$4::jsonb,$5::jsonb)`,
      [environment, input.productId, input.actorLabel.trim().slice(0, 120) || 'admin',
       JSON.stringify({ tire_size: tireSize, vehicle_model_id: input.vehicleModelId,
         position: input.position, affected_tire_specs: tireSpecIds.length,
         removed_rows: removed.rowCount ?? 0 }), JSON.stringify({ reason })],
    );
    await client.query('COMMIT');
    return { changed: (removed.rowCount ?? 0) > 0,
      fitments_removed: removed.rowCount ?? 0, tire_size: tireSize };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getCatalogCompatibility(
  productId: string,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<{
  product: {
    product_id: string;
    product_code: string;
    product_name: string;
    brand: string | null;
    tire_condition: TireCondition | null;
    tire_size: string | null;
  };
  summary: { models: number; fitments: number };
  rows: CatalogCompatibilityRow[];
}> {
  const product = await dbPool.query<{
    product_id: string;
    product_code: string;
    product_name: string;
    brand: string | null;
    tire_condition: TireCondition | null;
    tire_size: string | null;
  }>(
    `SELECT p.id AS product_id,p.product_code,p.product_name,p.brand,p.tire_condition,
            ts.tire_size
       FROM commerce.products p
       LEFT JOIN commerce.tire_specs ts
         ON ts.product_id=p.id AND ts.environment=p.environment
      WHERE p.environment=$1 AND p.id=$2
        AND p.product_type='tire' AND p.deleted_at IS NULL
      LIMIT 1`,
    [environment, productId],
  );
  const selected = product.rows[0];
  if (!selected) throw new Error('catalog_product_not_found');

  const fitments = await dbPool.query<CatalogCompatibilityRow>(
    `SELECT vm.id AS vehicle_model_id,vm.make,vm.model,vm.variant,
            vm.year_start,vm.year_end,vf.position,vf.is_oem,vf.source,
            vf.confidence_level
       FROM commerce.products p
       JOIN commerce.tire_specs ts
         ON ts.product_id=p.id AND ts.environment=p.environment
       JOIN commerce.vehicle_fitments vf
         ON vf.tire_spec_id=ts.id AND vf.environment=ts.environment
       JOIN commerce.vehicle_models vm
         ON vm.id=vf.vehicle_model_id AND vm.environment=vf.environment
      WHERE p.environment=$1 AND p.id=$2
        AND p.deleted_at IS NULL AND vm.deleted_at IS NULL
      ORDER BY vm.make,vm.model,vm.variant NULLS FIRST,vf.position`,
    [environment, productId],
  );
  return {
    product: selected,
    summary: {
      models: new Set(fitments.rows.map((row) => row.vehicle_model_id)).size,
      fitments: fitments.rows.length,
    },
    rows: fitments.rows,
  };
}

export * from './queries-catalogo-discoveries.js';

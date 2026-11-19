import { saveFitmentPeriod, selectFitmentPeriod, type FitmentPeriod } from './catalog-fitment-period.js';
import type { PoolClient as TransactionClient } from 'pg';
import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import type { TireCondition } from '../../shared/tire-condition.js';
import { applicationMeasureKey, type VehicleTireApplication } from '../../shared/vehicle-tire-applications.js';
import { loadVehicleApplicationCatalog } from '../../shared/vehicle-application-catalog.js';
import { repairVehicleApplicationTypes, type MotorcycleReference } from '../../shared/vehicle-application-type-repair.js';
import type { TireVehicleType } from '../../shared/tire-vehicle-type.js';

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


export interface CompatibilityMutationInput {
  previousPeriod?: FitmentPeriod;
  productId: string;
  vehicleModelId: string;
  position: 'front' | 'rear' | 'both';
  reason: string;
  actorLabel: string;
  environment?: 'prod' | 'test';
}

export interface AddCompatibilityInput extends CompatibilityMutationInput {
  isOem?: boolean;
  source?: 'manufacturer' | 'manual';
  confidenceLevel?: number;
  yearStart?: number | null;
  yearEnd?: number | null;
}

export function validateFitmentYears(
  yearStart?: number | null,
  yearEnd?: number | null,
): void {
  for (const year of [yearStart, yearEnd]) {
    if (year !== null && year !== undefined
      && (!Number.isInteger(year) || year < 1900 || year > 2100)) {
      throw new Error('catalog_compatibility_year_invalid');
    }
  }
  if (yearStart !== null && yearStart !== undefined
    && yearEnd !== null && yearEnd !== undefined && yearEnd < yearStart) {
    throw new Error('catalog_compatibility_year_range_invalid');
  }
}

export async function loadCatalogMeasureSpecs(
  client: PoolClient,
  environment: 'prod' | 'test',
  productId: string,
): Promise<{ tireSize: string; tireSpecIds: string[] }> {
  const selected = await client.query<{ tire_size: string; vehicle_type: TireVehicleType | null }>(
    `SELECT ts.tire_size,ts.vehicle_type
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
        AND ts.vehicle_type IS NOT DISTINCT FROM $3::text
        AND ($3::text IS DISTINCT FROM 'car' OR p.id=$4)
        AND regexp_replace(ts.tire_size,'[^0-9]+','','g')
            =regexp_replace($2,'[^0-9]+','','g')
      ORDER BY ts.id FOR UPDATE OF ts`,
    [environment, tireSize, selected.rows[0].vehicle_type ?? null, productId],
  );
  return { tireSize, tireSpecIds: specs.rows.map((row) => row.id) };
}

export async function addCatalogCompatibility(
  input: AddCompatibilityInput,
  dbPool: Pool = defaultPool, transactionClient?: TransactionClient
): Promise<{ changed: boolean; fitments_created: number; tire_size: string }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const reason = input.reason.trim();
  if (reason.length < 2 || reason.length > 500) throw new Error('catalog_compatibility_reason_required');
  if (input.confidenceLevel !== undefined && (!Number.isFinite(input.confidenceLevel) || input.confidenceLevel < 0
    || input.confidenceLevel > 1)) throw new Error('catalog_compatibility_confidence_invalid');
  validateFitmentYears(input.yearStart, input.yearEnd);
  if (input.previousPeriod && (input.yearStart === undefined || input.yearEnd === undefined)) {
    throw new Error('catalog_fitment_new_period_required');
  }
  const client = transactionClient ?? await dbPool.connect();
  try {
    if (!transactionClient) await client.query('BEGIN');
    const { tireSize, tireSpecIds } = await loadCatalogMeasureSpecs(client, environment, input.productId);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `catalog-fitment:${environment}:${tireSize.replace(/\D/g, '')}:${input.vehicleModelId}:${input.position}`,
    ]);
    const vehicle = await client.query<{ id: string; make: string; model: string }>(
      `SELECT id,make,model FROM commerce.vehicle_models
        WHERE environment=$1 AND id=$2 AND vehicle_type IN ('motorcycle','car')
          AND deleted_at IS NULL FOR UPDATE`,
      [environment, input.vehicleModelId],
    );
    if (!vehicle.rows[0]) throw new Error('catalog_vehicle_model_not_found');
    const inserted = await saveFitmentPeriod(client, environment, tireSpecIds, input);
    await client.query(
      `INSERT INTO audit.events
         (environment,domain,entity_table,entity_id,event_type,actor_label,payload_after)
       VALUES ($1,'catalog','commerce.products',$2,'catalog_measure_fitment_saved',$3,$4::jsonb)`,
      [environment, input.productId, input.actorLabel.trim().slice(0, 120) || 'admin',
       JSON.stringify({ tire_size: tireSize, vehicle_model_id: input.vehicleModelId,
         vehicle: vehicle.rows[0], position: input.position, is_oem: input.isOem,
         source: input.source, confidence_level: input.confidenceLevel, reason,
         previous_period: input.previousPeriod,
         year_start: input.yearStart ?? null, year_end: input.yearEnd ?? null,
         affected_tire_specs: tireSpecIds.length, changed_rows: inserted.rowCount ?? 0 })],
    );
    if (!transactionClient) await client.query('COMMIT');
    return { changed: (inserted.rowCount ?? 0) > 0,
      fitments_created: inserted.rowCount ?? 0, tire_size: tireSize };
  } catch (error) {
    if (!transactionClient) await client.query('ROLLBACK');
    throw error;
  } finally {
    if (!transactionClient) client.release();
  }
}

export async function removeCatalogCompatibility(
  input: CompatibilityMutationInput,
  dbPool: Pool = defaultPool, transactionClient?: TransactionClient
): Promise<{ changed: boolean; fitments_removed: number; tire_size: string }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const reason = input.reason.trim();
  if (reason.length < 2 || reason.length > 500) throw new Error('catalog_compatibility_reason_required');
  const client = transactionClient ?? await dbPool.connect();
  try {
    if (!transactionClient) await client.query('BEGIN');
    const { tireSize, tireSpecIds } = await loadCatalogMeasureSpecs(client, environment, input.productId);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `catalog-fitment:${environment}:${tireSize.replace(/\D/g, '')}:${input.vehicleModelId}:${input.position}`,
    ]);
    const period = await selectFitmentPeriod(client, environment, tireSpecIds, input);
    const removed = await client.query(
      `DELETE FROM commerce.vehicle_fitments
        WHERE environment=$1 AND vehicle_model_id=$2 AND position=$3
          AND tire_spec_id=ANY($4::uuid[])
          AND year_start IS NOT DISTINCT FROM $5::int AND year_end IS NOT DISTINCT FROM $6::int`,
      [environment, input.vehicleModelId, input.position, tireSpecIds, period.year_start, period.year_end],
    );
    await client.query(
      `INSERT INTO audit.events
         (environment,domain,entity_table,entity_id,event_type,actor_label,payload_before,payload_after)
       VALUES ($1,'catalog','commerce.products',$2,'catalog_measure_fitment_removed',$3,$4::jsonb,$5::jsonb)`,
      [environment, input.productId, input.actorLabel.trim().slice(0, 120) || 'admin',
       JSON.stringify({ tire_size: tireSize, vehicle_model_id: input.vehicleModelId,
         position: input.position, ...period, affected_tire_specs: tireSpecIds.length,
         removed_rows: removed.rowCount ?? 0 }), JSON.stringify({ reason })],
    );
    if (!transactionClient) await client.query('COMMIT');
    return { changed: (removed.rowCount ?? 0) > 0,
      fitments_removed: removed.rowCount ?? 0, tire_size: tireSize };
  } catch (error) {
    if (!transactionClient) await client.query('ROLLBACK');
    throw error;
  } finally {
    if (!transactionClient) client.release();
  }
}

export async function getCatalogMeasureApplications(
  measure: string,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
  vehicleType?: TireVehicleType | null,
) {
  const key = applicationMeasureKey(measure);
  const applications = await loadVehicleApplicationCatalog(dbPool, environment, key, vehicleType);
  const reviews = await dbPool.query(`SELECT application_id,vehicle_type,make,model,position,year_start,year_end,status,review_note
    FROM commerce.vehicle_measure_applications WHERE environment=$1
      AND display_measure=$2 AND status<>'verified' AND ($3::text IS NULL OR vehicle_type=$3)
    ORDER BY make,model,application_id`,
  [environment, key, vehicleType ?? null]);
  const referencias_para_classificar = key && (vehicleType === 'motorcycle' || vehicleType === undefined)
    ? (await repairVehicleApplicationTypes(dbPool, environment, key)).applications : [];
  return { applications, application_reviews: reviews.rows, referencias_para_classificar };
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
  applications: VehicleTireApplication[];
  referencias_para_classificar: MotorcycleReference[];
  application_reviews: Array<{ application_id: string; make: string; model: string;
    position: string; year_start: number | null; year_end: number | null; status: string; review_note: string }>;
}> {
  const product = await dbPool.query<{
    vehicle_type: TireVehicleType | null;
    product_id: string;
    product_code: string;
    product_name: string;
    brand: string | null;
    tire_condition: TireCondition | null;
    tire_size: string | null;
  }>(
    `SELECT p.id AS product_id,p.product_code,p.product_name,p.brand,p.tire_condition,
            ts.tire_size,ts.vehicle_type
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
            vf.year_start,vf.year_end,vf.position,vf.is_oem,vf.source,
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
      ORDER BY vm.make,vm.model,vm.variant NULLS FIRST,vf.position,vf.year_start NULLS FIRST,vf.year_end NULLS LAST`,
    [environment, productId],
  );
  const measureApplications = await getCatalogMeasureApplications(selected.tire_size ?? '', environment, dbPool, selected.vehicle_type);
  return {
    product: selected,
    summary: {
      models: new Set(fitments.rows.map((row) => row.vehicle_model_id)).size,
      fitments: fitments.rows.length,
    },
    rows: fitments.rows,
    ...measureApplications,
  };
}

export * from './queries-catalogo-discoveries.js';

export { searchCatalogVehicleModels, type CatalogVehicleModelRow } from './catalog-vehicle-models.js';

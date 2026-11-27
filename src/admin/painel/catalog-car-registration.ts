import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { applicationMeasureKey } from '../../shared/vehicle-tire-applications.js';
import type { CatalogVehicleModelRow } from './catalog-vehicle-models.js';
import type { carModelBody, carReferenceBody } from './route-catalogo-carros.js';

export type Environment = 'prod' | 'test';
export type Vehicle = CatalogVehicleModelRow & {vehicle_type: 'car'; aliases: string[]};
export const vehicleFields = 'id AS vehicle_model_id, vehicle_type, make, model, variant, year_start, year_end, displacement_cc, aliases';

export async function recordModelEvent(client: PoolClient, environment: Environment, vehicleId: string,
  event: string, actor: string, payload: object, before?: object) {
  await client.query(`INSERT INTO audit.events
    (environment, domain, entity_table, entity_id, event_type, actor_label, payload_after, payload_before)
    VALUES ($1,'catalog','commerce.vehicle_models',$2,$3,$4,$5::jsonb,$6::jsonb)`,
  [environment, vehicleId, event, actor, payload, before ?? null]);
}

type CarIdentity = z.infer<typeof carModelBody>;
export async function lockCarIdentity(client: PoolClient, environment: Environment, input: CarIdentity, excludeId?: string) {
  const {make, model, year_start, year_end} = input;
  const variant = input.variant || null;
  // Todos os períodos da mesma identidade competem pela mesma trava, inclusive no painel.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended(lower($1),0))',
    [JSON.stringify([environment, 'car', make, model, variant])]);
  return client.query<Vehicle & {deleted_at: Date | null}>(`SELECT ${vehicleFields}, deleted_at
    FROM commerce.vehicle_models WHERE environment=$1 AND vehicle_type='car'
    AND (id IS DISTINCT FROM $7::uuid)
    AND ((deleted_at IS NULL AND (year_start IS NULL OR year_start <= $6) AND (year_end IS NULL OR year_end >= $5))
      OR year_start=$5)
    AND lower(btrim(regexp_replace(make,'[[:space:]]+',' ','g')))=lower($2)
    AND lower(btrim(regexp_replace(model,'[[:space:]]+',' ','g')))=lower($3)
    AND lower(btrim(regexp_replace(coalesce(variant,''),'[[:space:]]+',' ','g')))=lower(coalesce($4,''))
    ORDER BY deleted_at NULLS FIRST,id LIMIT 2`, [environment, make, model, variant, year_start, year_end, excludeId ?? null]);
}

export async function createCatalogCarModel(client: PoolClient, environment: Environment,
  input: z.infer<typeof carModelBody>, actor: string) {
  const {make, model, year_start, year_end} = input;
  const variant = input.variant || null;
  const found = await lockCarIdentity(client, environment, input);
  if (found.rows.length) {
    const {deleted_at, ...vehicle} = found.rows[0]!;
    if (deleted_at || vehicle.year_start !== year_start || vehicle.year_end !== year_end || found.rows[1]?.deleted_at === null
      || (input.aliases && JSON.stringify(input.aliases)!==JSON.stringify(vehicle.aliases)))
      throw new Error('catalog_vehicle_model_conflict');
    return {created: false, vehicle};
  }
  const result = await client.query<Vehicle>(`INSERT INTO commerce.vehicle_models
    (environment,vehicle_type,make,model,variant,year_start,year_end,aliases)
    VALUES ($1,'car',$2,$3,$4,$5,$6,$7) RETURNING ${vehicleFields}`,
  [environment, make, model, variant, year_start, year_end,input.aliases ?? []]);
  const vehicle = result.rows[0]!;
  await recordModelEvent(client, environment, vehicle.vehicle_model_id, 'catalog_car_model_created', actor, vehicle);
  return {created: true, vehicle};
}

export async function createCarMeasureApplications(client: PoolClient, environment: Environment,
  productId: string, input: z.infer<typeof carReferenceBody>, actor: string) {
  const product = (await client.query<{vehicle_type: string | null; tire_size: string}>(`
    SELECT ts.vehicle_type, ts.tire_size FROM commerce.products p JOIN commerce.tire_specs ts
      ON ts.environment=p.environment AND ts.product_id=p.id
    WHERE p.environment=$1 AND p.id=$2 AND p.product_type='tire' AND p.deleted_at IS NULL
    FOR SHARE OF p,ts`, [environment, productId])).rows[0];
  if (!product) throw new Error('catalog_product_not_found');
  if (product.vehicle_type !== 'car') throw new Error('catalog_car_required');
  const displayMeasure = applicationMeasureKey(input.tire_size);
  if (!displayMeasure || displayMeasure !== applicationMeasureKey(product.tire_size))
    throw new Error('catalog_application_measure_mismatch');
  return saveCarMeasureApplications(client, environment, input, actor);
}

export async function saveCarMeasureApplications(client: PoolClient, environment: Environment,
  input: z.infer<typeof carReferenceBody>, actor: string, replaceIds: readonly string[] = []) {
  const displayMeasure = applicationMeasureKey(input.tire_size);
  if (!displayMeasure) throw new Error('catalog_application_measure_mismatch');
  const vehicle = (await client.query<Vehicle>(`SELECT ${vehicleFields} FROM commerce.vehicle_models
    WHERE environment=$1 AND id=$2 AND vehicle_type='car' AND deleted_at IS NULL FOR UPDATE`,
  [environment, input.vehicle_model_id])).rows[0];
  if (!vehicle) throw new Error('catalog_vehicle_model_not_found');
  if ((vehicle.year_start !== null && input.year_start < vehicle.year_start)
    || (vehicle.year_end !== null && input.year_end > vehicle.year_end))
    throw new Error('catalog_application_years_mismatch');

  const model = [vehicle.model, vehicle.variant].filter(Boolean).join(' ');
  const positions = input.position === 'both' ? ['front', 'rear'] as const : [input.position];
  let created = 0;
  const application_ids: string[] = [];
  for (const position of positions) {
    const applicationId = ['car', vehicle.vehicle_model_id, input.year_start, input.year_end, position, displayMeasure].join(':');
    application_ids.push(applicationId);
    const reference = {
      vehicle_model_id: vehicle.vehicle_model_id, vehicle_variant: vehicle.variant, reference_model: model,
      reference_year_start: input.year_start, reference_year_end: input.year_end,
      year_reference: input.year_start === input.year_end ? String(input.year_start) : `${input.year_start}–${input.year_end}`,
      range_source_urls: input.source_url ? [input.source_url] : [], source_url: input.source_url,
      source_type: input.source_url ? 'Fonte do fabricante conferida pela Matriz' : 'Cadastro manual da Matriz',
      source_checked_at: input.source_url ? new Date().toISOString().slice(0, 10) : null,
      index_spec: input.index_spec || null, mounting: 'ND', notes: '',
      validation_scope: input.source_url ? 'manufacturer_measure' : 'catalog_measure', product_fitment_confirmed: false,
    };
    if (replaceIds.includes(applicationId)) {
      await client.query(`UPDATE commerce.vehicle_measure_applications
        SET tire_size=$3, reference=reference || $4::jsonb, import_batch='matriz-car-manual', review_note=''
        WHERE environment=$1 AND application_id=$2`, [environment, applicationId, input.tire_size, reference]);
      continue;
    }
    const saved = await client.query(`INSERT INTO commerce.vehicle_measure_applications
      (environment, application_id, vehicle_type, make, model, position, tire_size, display_measure,
       year_start, year_end, status, application_kind, reference, import_batch,aliases)
      VALUES ($1,$2,'car',$3,$4,$5,$6,$7,$8,$9,'verified','original',$10::jsonb,'matriz-car-manual',$11)
      ON CONFLICT (environment, application_id) DO NOTHING`, [environment, applicationId, vehicle.make,
      model, position, input.tire_size, displayMeasure, input.year_start, input.year_end, reference,vehicle.aliases]);
    if (saved.rowCount) {
      created++;
      await recordModelEvent(client, environment, vehicle.vehicle_model_id, 'catalog_car_measure_application_created', actor,
        {application_id: applicationId, position, tire_size: input.tire_size, year_start: input.year_start,
          year_end: input.year_end, index_spec: reference.index_spec, source_url: input.source_url});
    } else {
      if (replaceIds.length) {
        // Uma correção pode restabelecer uma identificação já arquivada. Dois registros ativos não se fundem.
        const restored = await client.query(`UPDATE commerce.vehicle_measure_applications SET status='verified',
          tire_size=$4,reference=(reference-'archived_with_vehicle') || $5::jsonb,
          review_note='',import_batch='matriz-car-manual'
          WHERE environment=$1 AND application_id=$2 AND vehicle_type='car' AND application_kind='original'
          AND reference->>'vehicle_model_id'=$3 AND status='rejected'`,
        [environment,applicationId,vehicle.vehicle_model_id,input.tire_size,reference]);
        if (!restored.rowCount) throw new Error('catalog_application_conflict');
        continue;
      }
      const same = await client.query(`SELECT 1 FROM commerce.vehicle_measure_applications
        WHERE environment=$1 AND application_id=$2 AND vehicle_type='car' AND status='verified' AND application_kind='original'
        AND tire_size=$3 AND (reference->>'source_url') IS NOT DISTINCT FROM $4
        AND (reference->>'index_spec') IS NOT DISTINCT FROM $5
        FOR SHARE`, [environment, applicationId, input.tire_size, input.source_url, reference.index_spec]);
      if (!same.rowCount) throw new Error('catalog_application_conflict');
    }
  }
  return {created, application_ids};
}

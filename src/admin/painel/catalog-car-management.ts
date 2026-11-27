import type { Pool, PoolClient } from 'pg';
import type { z } from 'zod';
import { lockCarIdentity, recordModelEvent, saveCarMeasureApplications, vehicleFields, type Environment,
  type Vehicle } from './catalog-car-registration.js';
import type { carModelBody, carReferenceBody } from './route-catalogo-carros.js';

type ModelInput = z.infer<typeof carModelBody>;
type ReferenceInput = z.infer<typeof carReferenceBody>;
type VehicleState = Vehicle & {deleted_at: Date | null};
type Db = Pick<Pool | PoolClient, 'query'>;
type Period = {year_start: number | null; year_end: number | null};
type Reference = Period & {application_id: string; position: 'front' | 'rear'; tire_size: string; aliases: string[];
  display_measure: string; status: string; source_url: string | null; index_spec: string | null};
const referenceFields = `application_id,position,tire_size,display_measure,year_start,year_end,status,aliases,
  reference->>'source_url' AS source_url,reference->>'index_spec' AS index_spec`;
const linkedReference = `environment=$1 AND vehicle_type='car' AND reference->>'vehicle_model_id'=$2`;

export async function findCarApplications(db: Db, environment: Environment,
  input: {make?: string; model: string; variant?: string; year?: number; include_archived?: boolean}) {
  const result = await db.query(`SELECT v.id AS vehicle_model_id,v.make,v.model,v.variant,v.year_start,v.year_end,
    v.aliases,v.deleted_at IS NOT NULL AS archived,
    coalesce((SELECT jsonb_agg(jsonb_build_object('application_id',a.application_id,'position',a.position,
      'tire_size',a.tire_size,'year_start',a.year_start,'year_end',a.year_end,'status',a.status,
      'source_url',a.reference->>'source_url','index_spec',a.reference->>'index_spec','aliases',a.aliases) ORDER BY a.position,a.tire_size,a.application_id)
      FROM commerce.vehicle_measure_applications a WHERE a.environment=v.environment AND a.vehicle_type='car'
      AND a.reference->>'vehicle_model_id'=v.id::text AND ($6 OR a.status='verified')
      AND ($5::int IS NULL OR ((a.year_start IS NULL OR a.year_start <= $5) AND (a.year_end IS NULL OR a.year_end >= $5)))), '[]') AS applications
    FROM commerce.vehicle_models v WHERE v.environment=$1 AND v.vehicle_type='car' AND ($6 OR v.deleted_at IS NULL)
    AND lower(v.model)=lower($2) AND ($3::text IS NULL OR lower(v.make)=lower($3))
    AND ($4::text IS NULL OR lower(v.variant)=lower($4))
    AND ($5::int IS NULL OR ((v.year_start IS NULL OR v.year_start <= $5) AND (v.year_end IS NULL OR v.year_end >= $5)))
    ORDER BY v.make,v.model,v.variant NULLS FIRST,v.year_start,v.id`,
  [environment,input.model,input.make ?? null,input.variant ?? null,input.year ?? null,input.include_archived ?? false]);
  return {vehicles: result.rows};
}

export async function carImpact(db: PoolClient, environment: Environment, id: string) {
  const vehicle = (await db.query<VehicleState>(`SELECT ${vehicleFields},deleted_at FROM commerce.vehicle_models
    WHERE environment=$1 AND vehicle_type='car' AND id=$2 FOR UPDATE`, [environment,id])).rows[0];
  if (!vehicle) throw Error('catalog_vehicle_model_not_found');
  const references = (await db.query<Reference>(`SELECT ${referenceFields} FROM commerce.vehicle_measure_applications
    WHERE ${linkedReference} ORDER BY application_id`,[environment,id])).rows;
  const fitments = (await db.query<Period & {product_id: string}>(`SELECT ts.product_id,p.product_code,
    f.position,f.year_start,f.year_end,f.is_oem,f.source FROM commerce.vehicle_fitments f
    JOIN commerce.tire_specs ts ON ts.environment=f.environment AND ts.id=f.tire_spec_id
    JOIN commerce.products p ON p.environment=ts.environment AND p.id=ts.product_id
    WHERE f.environment=$1 AND f.vehicle_model_id=$2 ORDER BY p.product_code,f.id`, [environment,id])).rows;
  const discoveries = (await db.query(`SELECT id,status,suggested_year_start,suggested_year_end
    FROM commerce.fitment_discoveries WHERE environment=$1 AND vehicle_model_id=$2 ORDER BY id`, [environment,id])).rows;
  return {vehicle,references,fitments,discoveries};
}

function outsidePeriod(row: Period, input: ModelInput) {
  return (row.year_start !== null && row.year_start < input.year_start)
    || (row.year_end !== null && row.year_end > input.year_end);
}

export async function correctCarModel(db: PoolClient, environment: Environment, id: string, input: ModelInput,
  reason: string, actor: string) {
  const before = await carImpact(db,environment,id);
  if (before.vehicle.deleted_at) throw Error('catalog_vehicle_archived');
  if ((await lockCarIdentity(db,environment,input,id)).rowCount) throw Error('catalog_vehicle_model_conflict');
  if (before.references.some(row => row.status==='verified' && outsidePeriod(row,input))
    || before.fitments.some(row => outsidePeriod(row,input))
    || before.discoveries.some(row => row.status==='pending' && outsidePeriod({
      year_start: row.suggested_year_start, year_end: row.suggested_year_end}, input)))
    throw Error('catalog_vehicle_dependent_years_conflict');
  const identityChanged = before.vehicle.make!==input.make || before.vehicle.model!==input.model
    || before.vehicle.variant!==(input.variant || null);
  // Apelidos antigos podem ainda apontar para a identidade substituída.
  const aliases = input.aliases ?? (identityChanged ? [] : null);
  const vehicle = (await db.query<Vehicle>(`UPDATE commerce.vehicle_models SET make=$3,model=$4,
    variant=$5,year_start=$6,year_end=$7,aliases=coalesce($8::text[],aliases),updated_at=now()
    WHERE environment=$1 AND id=$2 RETURNING ${vehicleFields}`,
  [environment,id,input.make,input.model,input.variant || null,input.year_start,input.year_end,aliases])).rows[0]!;
  const fullModel = [vehicle.model,vehicle.variant].filter(Boolean).join(' ');
  await db.query(`UPDATE commerce.vehicle_measure_applications SET make=$3,model=$4,
    reference=reference || jsonb_build_object('reference_model',$4::text,'vehicle_variant',$5::text),
    aliases=coalesce($6::text[],aliases) WHERE ${linkedReference}`, [environment,id,vehicle.make,fullModel,vehicle.variant,aliases]);
  await recordModelEvent(db,environment,id,'catalog_car_model_corrected',actor,{vehicle,reason},before);
  return {vehicle};
}

export async function setCarStatus(db: PoolClient, environment: Environment, id: string, active: boolean,
  reason: string, actor: string) {
  const before = await carImpact(db,environment,id);
  const vehicle = before.vehicle;
  if (active === !vehicle.deleted_at) return {changed:false,active};
  if (active) {
    const others = await lockCarIdentity(db,environment,{...vehicle,
      year_start:vehicle.year_start ?? 1900,year_end:vehicle.year_end ?? 2100},id);
    if (others.rowCount) throw Error('catalog_vehicle_model_conflict');
  }
  const updated = await db.query(`UPDATE commerce.vehicle_measure_applications
    SET status=CASE WHEN $3 THEN 'verified' ELSE 'rejected' END,
      reference=CASE WHEN $3 THEN reference-'archived_with_vehicle'
        ELSE reference || '{"archived_with_vehicle":true}'::jsonb END
    WHERE ${linkedReference} AND (($3 AND status='rejected' AND reference @> '{"archived_with_vehicle":true}'::jsonb)
    OR (NOT $3 AND status='verified'))`,[environment,id,active]);
  await db.query(`UPDATE commerce.vehicle_models SET deleted_at=CASE WHEN $3 THEN NULL ELSE now() END,
    updated_at=now() WHERE environment=$1 AND id=$2`,[environment,id,active]);
  const result = {changed:true,active,references_changed:updated.rowCount};
  await recordModelEvent(db,environment,id,active?'catalog_car_model_reactivated':'catalog_car_model_archived',
    actor,{...result,reason},before);
  return result;
}

function selectReferences(impact: Awaited<ReturnType<typeof carImpact>>, ids: string[]) {
  if (impact.vehicle.deleted_at) throw Error('catalog_vehicle_archived');
  const selected = impact.references.filter(row=>ids.includes(row.application_id));
  if (!ids.length || selected.length!==ids.length) throw Error('catalog_car_reference_not_found');
  return selected;
}

export async function correctCarReferences(db: PoolClient, environment: Environment, ids: string[],
  input: ReferenceInput, reason: string, actor: string) {
  const impact = await carImpact(db,environment,input.vehicle_model_id);
  const before = selectReferences(impact,ids);
  if (before.some(row=>row.status!=='verified')) throw Error('catalog_car_reference_inactive');
  if (before.length>1 && (new Set(before.map(row=>row.position)).size!==2
    || before.some(row=>row.tire_size!==before[0]!.tire_size || row.year_start!==before[0]!.year_start
      || row.year_end!==before[0]!.year_end))) throw Error('catalog_car_reference_selection_conflict');
  const saved = await saveCarMeasureApplications(db,environment,input,actor,ids);
  const aliases = [...new Set(before.flatMap(row=>row.aliases))];
  if (aliases.length) await db.query(`UPDATE commerce.vehicle_measure_applications SET aliases=$4
    WHERE ${linkedReference} AND application_id=ANY($3::text[]) AND cardinality(aliases)=0`,
  [environment,input.vehicle_model_id,saved.application_ids,aliases]);
  const obsolete = ids.filter(id=>!saved.application_ids.includes(id));
  if (obsolete.length) await db.query(`UPDATE commerce.vehicle_measure_applications SET status='rejected',review_note=$4
    WHERE ${linkedReference} AND application_id=ANY($3::text[])`,[environment,input.vehicle_model_id,obsolete,reason]);
  await recordModelEvent(db,environment,input.vehicle_model_id,'catalog_car_reference_corrected',actor,
    {application_ids:saved.application_ids,input,reason},
    {references:impact.references.filter(row=>ids.includes(row.application_id) || saved.application_ids.includes(row.application_id))});
  return saved;
}

export async function setReferenceStatus(db: PoolClient, environment: Environment, id: string, ids: string[],
  active: boolean, reason: string, actor: string) {
  const impact = await carImpact(db,environment,id);
  const before = selectReferences(impact,ids);
  if (active && before.some(row=>(impact.vehicle.year_start!==null && (row.year_start===null || row.year_start<impact.vehicle.year_start))
    || (impact.vehicle.year_end!==null && (row.year_end===null || row.year_end>impact.vehicle.year_end))))
    throw Error('catalog_application_years_mismatch');
  const result = await db.query(`UPDATE commerce.vehicle_measure_applications SET status=$4,review_note=$5,
    reference=reference-'archived_with_vehicle'
    WHERE ${linkedReference} AND application_id=ANY($3::text[]) AND status<>$4`,
  [environment,id,ids,active?'verified':'rejected',reason]);
  if (result.rowCount) await recordModelEvent(db,environment,id,active?'catalog_car_reference_reactivated':'catalog_car_reference_archived',
    actor,{application_ids:ids,reason},{references:before});
  return {changed:result.rowCount,active,application_ids:ids};
}

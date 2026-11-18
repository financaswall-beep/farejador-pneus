import type { PoolClient } from 'pg';
import type { AddCompatibilityInput, CompatibilityMutationInput } from './queries-catalogo-compatibilidade.js';

export interface FitmentPeriod { year_start: number | null; year_end: number | null }

// O chamador já mantém os tire_specs do escopo travados durante a transação.
export async function selectFitmentPeriod(client: PoolClient, environment: string,
  tireSpecIds: string[], input: CompatibilityMutationInput): Promise<FitmentPeriod> {
  const periods = await client.query<FitmentPeriod & { selected: boolean }>(
    `SELECT vf.year_start,vf.year_end,bool_or(ts.product_id=$5) selected
       FROM commerce.vehicle_fitments vf
       JOIN commerce.tire_specs ts ON ts.environment=vf.environment AND ts.id=vf.tire_spec_id
      WHERE vf.environment=$1 AND vf.vehicle_model_id=$2 AND vf.position=$3
        AND vf.tire_spec_id=ANY($4::uuid[])
      GROUP BY vf.year_start,vf.year_end`,
    [environment, input.vehicleModelId, input.position, tireSpecIds, input.productId]);
  const previous = input.previousPeriod;
  if (!previous && periods.rows.length > 1) throw new Error('catalog_fitment_period_ambiguous');
  const target = periods.rows.find(row => row.selected && (!previous ||
    (row.year_start === previous.year_start && row.year_end === previous.year_end)));
  if (!target) throw new Error('catalog_fitment_period_not_found');
  return { year_start: target.year_start, year_end: target.year_end };
}

export async function saveFitmentPeriod(client: PoolClient, environment: string,
  tireSpecIds: string[], input: AddCompatibilityInput) {
  if (input.previousPeriod) {
    const before = await selectFitmentPeriod(client, environment, tireSpecIds, input);
    try {
      return await client.query(
        `UPDATE commerce.vehicle_fitments SET year_start=$7,year_end=$8,
                is_oem=coalesce($9,is_oem),source=coalesce($10,source),
                confidence_level=coalesce($11,confidence_level),updated_at=now()
          WHERE environment=$1 AND vehicle_model_id=$2 AND position=$3 AND tire_spec_id=ANY($4::uuid[])
            AND year_start IS NOT DISTINCT FROM $5::int AND year_end IS NOT DISTINCT FROM $6::int`,
        [environment, input.vehicleModelId, input.position, tireSpecIds, before.year_start, before.year_end,
         input.yearStart ?? null, input.yearEnd ?? null, input.isOem, input.source, input.confidenceLevel]);
    } catch (error) {
      if ((error as { constraint?: string }).constraint === 'vehicle_fitments_period_key') {
        throw new Error('catalog_fitment_period_already_exists');
      }
      throw error;
    }
  }
  return client.query(
    `INSERT INTO commerce.vehicle_fitments
       (environment,vehicle_model_id,tire_spec_id,position,is_oem,source,confidence_level,
        year_start,year_end)
     SELECT $1::env_t,$2,spec_id,$3,$4,$5,$6,$7,$8
       FROM unnest($9::uuid[]) AS spec_id
     ON CONFLICT ON CONSTRAINT vehicle_fitments_period_key DO NOTHING`,
    [environment, input.vehicleModelId, input.position, input.isOem ?? false, input.source ?? 'manual',
     input.confidenceLevel ?? 1, input.yearStart ?? null, input.yearEnd ?? null, tireSpecIds],
  );
}

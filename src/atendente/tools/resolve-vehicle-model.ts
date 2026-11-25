import type { PoolClient } from 'pg';
import type { BuscarCompatibilidadeInput } from './commerce-tool-inputs.js';

interface ResolvedVehicle {
  vehicle_model_id: string;
  make: string;
  model: string;
  variant: string | null;
  year_start: number | null;
  year_end: number | null;
  displacement_cc: number | null;
}

export function resolveVehicleModel(client: PoolClient, input: BuscarCompatibilidadeInput) {
  // A categoria participa da seleção antes do limite. Preserve o ranking histórico
  // das motos (0047), inclusive o alias de família e a preferência por vínculo útil.
  return client.query<ResolvedVehicle>(`
    WITH resolve_vehicle_model AS (
      SELECT v.*, lower(trim($2::text)) AS term,
             trim(v.model || coalesce(' ' || v.variant, '')) AS model_variant,
             trim(v.make || ' ' || v.model || coalesce(' ' || v.variant, '')) AS full_name
        FROM commerce.vehicle_models v
       WHERE v.environment=$1 AND v.deleted_at IS NULL AND v.vehicle_type=$4
         AND ($3::int IS NULL OR v.year_start IS NULL OR v.year_start <= $3)
         AND ($3::int IS NULL OR v.year_end IS NULL OR v.year_end >= $3)
    ), matches AS (
      SELECT v.*, CASE WHEN term IN (lower(full_name),lower(model_variant)) THEN 1
                       WHEN term=lower(model) OR ($4='car' AND term=lower(make || ' ' || model)) THEN 2
                       WHEN term = ANY (SELECT lower(a) FROM unnest(aliases) a) THEN 3
                       ELSE 4 END AS match_rank,
             greatest(similarity(model,$2),similarity(model_variant,$2),similarity(full_name,$2)) AS score
        FROM resolve_vehicle_model v
    )
    SELECT id AS vehicle_model_id,make,model,variant,year_start,year_end,displacement_cc,
           (ARRAY['exact_full','exact_model','alias','fuzzy'])[match_rank] AS match_type,
           CASE match_rank WHEN 1 THEN 1.00 WHEN 2 THEN 0.90 WHEN 3 THEN 0.95 ELSE score::numeric END AS match_similarity
      FROM matches m
     WHERE match_rank < 4 OR ($4='motorcycle' AND score > 0.5)
     ORDER BY EXISTS (SELECT 1 FROM commerce.vehicle_fitments f
                       WHERE f.environment=$1 AND f.vehicle_model_id=m.id) DESC,
              coalesce($3 BETWEEN year_start AND year_end,false) DESC,
              (variant IS NOT NULL) DESC,(year_start IS NOT NULL) DESC,
              match_rank, CASE WHEN match_rank=4 THEN score END DESC,
              year_end DESC NULLS LAST,model,variant NULLS LAST,id
     LIMIT 5`, [input.environment, input.moto_modelo, input.moto_ano ?? null, input.tipo_veiculo ?? 'motorcycle']);
}

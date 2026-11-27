import type { PoolClient } from 'pg';
import type { CatalogApplication } from '../shared/vehicle-application-catalog.js';
import type { vehicleApplicationAnswer } from './vehicle-application-answer.js';

/** A dimensão técnica guia a busca. A aprovação de um SKU depende de vínculo
 * próprio em todas as configurações/eixos que a pergunta ainda pode representar. */
async function hasCarProductFitment(client: PoolClient, environment: 'prod' | 'test', productId: string,
  year: number | undefined, rows: CatalogApplication[], partial: boolean): Promise<boolean> {
  if (!year || partial || !rows.length || rows.some(row => !row.vehicle_model_id)) return false;
  const {rows: result} = await client.query<{confirmed: boolean}>(`
    SELECT bool_and(EXISTS (
      SELECT 1 FROM commerce.vehicle_fitments f
      JOIN commerce.vehicle_models v ON v.environment=f.environment AND v.id=f.vehicle_model_id
      JOIN commerce.tire_specs t ON t.environment=f.environment AND t.id=f.tire_spec_id
      JOIN commerce.products p ON p.environment=t.environment AND p.id=t.product_id
      WHERE f.environment=$1 AND v.id=r.vehicle AND t.product_id=$2::uuid
        AND p.deleted_at IS NULL AND v.deleted_at IS NULL AND t.vehicle_type='car' AND v.vehicle_type='car'
        AND f.position::text IN ('both',r.axis)
        AND (f.year_start IS NULL OR f.year_start <= $3) AND (f.year_end IS NULL OR f.year_end >= $3)
        AND (v.year_start IS NULL OR v.year_start <= $3) AND (v.year_end IS NULL OR v.year_end >= $3)
        AND regexp_replace(regexp_replace(upper(t.tire_size),'[[:space:]]','','g'),'ZR|R','-') = r.measure
    )) AS confirmed FROM unnest($4::uuid[],$5::text[],$6::text[]) AS r(vehicle,axis,measure)`,
  [environment, productId, year, rows.map(row => row.vehicle_model_id), rows.map(row => row.position), rows.map(row => row.display_measure)]);
  return result[0]?.confirmed === true;
}

export async function reportCarProductFitment(client: PoolClient, environment: 'prod' | 'test', productId: string,
  year: number | undefined, application: NonNullable<ReturnType<typeof vehicleApplicationAnswer>>) {
  const confirmed = await hasCarProductFitment(client, environment, productId, year, application.aplicacoes,
    'resultado_parcial' in application && application.resultado_parcial === true);
  return JSON.stringify({...application, produto_consultado: productId, produto_confirmado: confirmed,
    proximo_passo: confirmed ? 'O produto possui vínculo verificado para esta aplicação. Consulte a loja para preço e disponibilidade.'
      : 'A medida consta para o veículo. A compatibilidade deste produto específico depende de conferência da equipe.'});
}

import type { Pool } from 'pg';
import { pool } from '../../persistence/db.js';
import { loadCustomerLeadInterests } from '../painel/customer-lead-interests.js';

/** Classificação atual do catálogo, consultada somente ao abrir a ficha. */
export async function getOperationCustomerInterests(
  environment: 'prod' | 'test', conversationId: string, db: Pool = pool,
) {
  const interests = (await loadCustomerLeadInterests(environment, [conversationId], db)).get(conversationId) ?? [];
  if (!interests.length) return [];
  const result = await db.query<{ measure: string; vehicle_type: string | null }>(
    `SELECT measure, commerce.catalog_vehicle_type($1::env_t,measure,NULL,NULL) AS vehicle_type
     FROM unnest($2::text[]) AS requested(measure)`,
    [environment, interests.map(interest => interest.measure)],
  );
  const types = new Map(result.rows.map(row => [row.measure, row.vehicle_type]));
  return interests.map(interest => {
    const type = types.get(interest.measure);
    // Medida ambígua ou sem classificação não recebe uma imagem de categoria inventada.
    return { ...interest, vehicle_type: type === 'car' || type === 'motorcycle' ? type : null };
  });
}

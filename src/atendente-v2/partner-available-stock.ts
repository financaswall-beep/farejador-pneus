import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';

// Mesma consulta da busca por município: maior oferta disponível por produto, após reservas.
export async function readPartnerAvailableStock(client: PoolClient, environment: Environment, unitId: string) {
  const result = await client.query<{ product_id: string; disponivel: string }>(
    `SELECT product_id,
            max(quantity_on_hand - COALESCE(quantity_reserved, 0))::text AS disponivel
     FROM commerce.partner_stock_levels
     WHERE environment = $1
       AND unit_id = $2
       AND product_id IS NOT NULL
       AND tire_condition IS NOT NULL
       AND deleted_at IS NULL
       AND is_tracked = true
       AND quantity_on_hand IS NOT NULL
       AND (quantity_on_hand - COALESCE(quantity_reserved, 0)) > 0
     GROUP BY product_id`, [environment, unitId],
  );
  const map = new Map<string, number>();
  for (const row of result.rows) map.set(row.product_id, Math.max(map.get(row.product_id) ?? 0, Number(row.disponivel)));
  return map;
}

import type { PoolClient } from 'pg';
import { tireSizeKey } from '../shared/tire-size.js';
import type { Environment } from '../shared/types/chatwoot.js';

export function tireSearchQuantity(args: Record<string, unknown>): number | undefined {
  const quantity = args.quantidade;
  return typeof quantity === 'number' && Number.isInteger(quantity) && quantity >= 1 && quantity <= 20
    ? quantity : undefined;
}

export async function isCarTireSearch(
  db: PoolClient, environment: Environment, args: Record<string, unknown>,
): Promise<boolean> {
  if (args.posicao_pneu || typeof args.medida_pneu !== 'string'
    || args.medida_pneu.match(/[0-9]+/g)?.length !== 3) return false;
  if (args.tipo_veiculo !== undefined) return args.tipo_veiculo === 'car';
  const { rows } = await db.query<{ all_car: boolean }>(`
    SELECT COALESCE(bool_and(ts.vehicle_type IS NOT DISTINCT FROM 'car'),false) AS all_car
      FROM commerce.tire_specs ts
      JOIN commerce.products p ON p.environment=ts.environment AND p.id=ts.product_id
     WHERE ts.environment=$1 AND p.product_type='tire' AND p.deleted_at IS NULL
       AND array_to_string(regexp_match(ts.tire_size,'([0-9]+)[^0-9]+([0-9]+)[^0-9]+([0-9]+)'),'-')=$2`,
  [environment, tireSizeKey(args.medida_pneu)]);
  return rows[0]?.all_car === true;
}

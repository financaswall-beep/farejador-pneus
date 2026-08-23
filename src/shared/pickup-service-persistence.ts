import type { PoolClient } from 'pg';
import {
  pickupServiceDefinition, type PickupService,
} from './pickup-services.js';

function centsToMoney(cents: number): string {
  return (cents / 100).toFixed(2);
}

export async function materializePartnerPickupServices(
  client: PoolClient,
  environment: 'prod' | 'test',
  orderId: string,
  services: readonly PickupService[],
): Promise<number> {
  let insertedCents = 0;
  for (const service of services) {
    const definition = pickupServiceDefinition(service.code);
    const amount = centsToMoney(service.amount_cents);
    const inserted = await client.query<{ unit_price: string }>(
      `INSERT INTO commerce.partner_order_items (
         environment,order_id,partner_stock_id,item_name,item_type,quantity,
         unit_price,discount_amount,reference_unit_price,unit_cost_snapshot,
         cost_status,cost_captured_at,cost_source,pickup_service_code
       ) VALUES ($1,$2,NULL,$3,'servico',1,$4,0,$4,0,
                 'known',now(),'service_no_inventory',$5)
       ON CONFLICT (environment,order_id,pickup_service_code)
         WHERE pickup_service_code IS NOT NULL DO NOTHING
       RETURNING unit_price::text`,
      [environment, orderId, definition.label, amount, service.code],
    );
    if (inserted.rows[0]) insertedCents += Math.round(Number(inserted.rows[0].unit_price) * 100);
  }
  return insertedCents;
}

export async function materializeMatrizPickupServices(
  client: PoolClient,
  environment: 'prod' | 'test',
  orderId: string,
  services: readonly PickupService[],
): Promise<number> {
  let insertedCents = 0;
  for (const service of services) {
    const definition = pickupServiceDefinition(service.code);
    const amount = centsToMoney(service.amount_cents);
    const inserted = await client.query<{ unit_price: string }>(
      `INSERT INTO commerce.order_items (
         environment,order_id,product_id,quantity,unit_price,discount_amount,
         reference_unit_price,matriz_unit_cost,pickup_service_code
       )
       SELECT $1,$2,p.id,1,$3,0,$3,0,$4
         FROM commerce.products p
        WHERE p.environment=$1 AND p.product_code=$5
          AND p.product_type='service' AND p.deleted_at IS NULL
       ON CONFLICT (environment,order_id,pickup_service_code)
         WHERE pickup_service_code IS NOT NULL DO NOTHING
       RETURNING unit_price::text`,
      [environment, orderId, amount, service.code, definition.matrixProductCode],
    );
    if (!inserted.rows[0]) {
      const exists = await client.query(
        `SELECT 1 FROM commerce.order_items
          WHERE environment=$1 AND order_id=$2 AND pickup_service_code=$3`,
        [environment, orderId, service.code],
      );
      if (!exists.rows[0]) throw new Error('pickup_service_catalog_missing');
    } else {
      insertedCents += Math.round(Number(inserted.rows[0].unit_price) * 100);
    }
  }
  return insertedCents;
}

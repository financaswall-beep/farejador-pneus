import type { PoolClient } from 'pg';
import { normalizeBrazilianPhone } from '../../shared/phone.js';
import type { RegisterWholesaleSaleInput } from './queries-atacado-vendas.js';

export async function resolveWholesaleBuyer(
  client: PoolClient,
  environment: 'prod' | 'test',
  input: RegisterWholesaleSaleInput,
): Promise<{ id: string; name: string; partner_id: string | null }> {
  if (input.customer_id) {
    const found = await client.query<{ id: string; name: string; partner_id: string | null }>(
      `SELECT id,name,partner_id FROM commerce.wholesale_customers
        WHERE id=$1 AND environment=$2 AND deleted_at IS NULL`,
      [input.customer_id, environment],
    );
    if (!found.rows[0]) throw new Error('buyer_not_found');
    return found.rows[0];
  }
  if (input.partner_id) {
    const partner = await client.query<{ trade_name: string; whatsapp_phone: string | null }>(
      `SELECT trade_name,whatsapp_phone FROM network.partners
        WHERE id=$1 AND environment=$2 AND deleted_at IS NULL AND status='active' FOR SHARE`,
      [input.partner_id, environment],
    );
    if (!partner.rows[0]) throw new Error('partner_not_found');
    const buyer = await client.query<{ id: string; name: string }>(
      `INSERT INTO commerce.wholesale_customers (environment,partner_id,name,phone)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (environment,partner_id) WHERE partner_id IS NOT NULL AND deleted_at IS NULL
       DO UPDATE SET updated_at=commerce.wholesale_customers.updated_at
       RETURNING id,name`,
      [environment, input.partner_id, partner.rows[0].trade_name, partner.rows[0].whatsapp_phone],
    );
    return { ...buyer.rows[0]!, partner_id: input.partner_id };
  }
  const name = input.new_customer?.name.trim();
  if (!name) throw new Error('buyer_required');
  const buyer = await client.query<{ id: string; name: string }>(
    `INSERT INTO commerce.wholesale_customers (environment,name,phone)
     VALUES ($1,$2,$3) RETURNING id,name`,
    [environment, name, input.new_customer?.phone
      ? normalizeBrazilianPhone(input.new_customer.phone) : null],
  );
  return { ...buyer.rows[0]!, partner_id: null };
}

export async function resolveAdditionBuyer(
  client: PoolClient,
  environment: 'prod' | 'test',
  parentOrderId: string,
): Promise<{ id: string; name: string; partner_id: string | null; partner_unit_id: string | null }> {
  const result = await client.query<{
    id: string; name: string; partner_id: string | null; partner_unit_id: string | null;
  }>(
    `SELECT c.id,c.name,c.partner_id,o.partner_unit_id
       FROM commerce.wholesale_orders o
       JOIN commerce.wholesale_customers c
         ON c.environment=o.environment AND c.id=o.buyer_id AND c.deleted_at IS NULL
      WHERE o.environment=$1 AND o.id=$2
        AND (o.status='confirmed'
          OR (o.status='pending' AND o.partner_transfer_status='in_transit'))
        AND o.parent_order_id IS NULL
      FOR UPDATE OF o,c`,
    [environment, parentOrderId],
  );
  if (!result.rows[0]) throw new Error('wholesale_parent_order_not_open_root');
  return result.rows[0];
}

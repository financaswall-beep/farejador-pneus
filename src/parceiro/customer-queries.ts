import type { PartnerContext } from './auth.js';
import { withPartnerContext } from './db.js';

const customerMetricsSql = `
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS purchases,sum(po.total_amount) AS total_spent,
           max(CASE WHEN po.fulfillment_mode='delivery' THEN po.delivered_at
                    ELSE COALESCE(po.retrieved_at,po.created_at) END) AS last_purchase_at
      FROM commerce.partner_orders po
     WHERE po.environment=pc.environment AND po.unit_id=pc.unit_id AND po.customer_id=pc.id
       AND po.status<>'cancelled' AND po.deleted_at IS NULL
       AND NOT (po.fulfillment_mode='delivery' AND po.delivery_status<>'delivered')
       AND NOT po.awaiting_pickup
  ) sales ON true`;

const customerColumnsSql = `pc.id,pc.name,pc.phone,pc.cpf,pc.address,
  pc.address_street,pc.address_number,pc.address_neighborhood,pc.address_city,
  (COALESCE(sales.purchases,0)>=3) AS is_vip,COALESCE(sales.purchases,0)::int AS purchases,
  COALESCE(sales.total_spent,0)::float8 AS total_spent,
  sales.last_purchase_at::text,pc.created_at,pc.updated_at`;

export async function getPartnerCustomers(ctx: PartnerContext): Promise<unknown[]> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const result = await client.query(
      `SELECT ${customerColumnsSql}
         FROM commerce.partner_customers pc
         ${customerMetricsSql}
        WHERE pc.environment=$1 AND pc.unit_id=$2 AND pc.deleted_at IS NULL
        ORDER BY pc.updated_at DESC LIMIT 300`,
      [ctx.environment,ctx.unitId],
    );
    return result.rows;
  });
}

export async function searchPartnerCustomers(ctx: PartnerContext, q: string): Promise<unknown[]> {
  const search = q.trim();
  if (!search) return [];
  const digits = search.replace(/\D/g,'');
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const result = await client.query(
      `SELECT ${customerColumnsSql}
         FROM commerce.partner_customers pc
         ${customerMetricsSql}
        WHERE pc.environment=$1 AND pc.unit_id=$2 AND pc.deleted_at IS NULL
          AND (lower(pc.name) LIKE lower($3)
            OR ($4<>'' AND pc.phone LIKE $5) OR ($4<>'' AND pc.cpf LIKE $5)
            OR lower(COALESCE(pc.address,'')) LIKE lower($3)
            OR lower(COALESCE(pc.address_street,'')) LIKE lower($3)
            OR lower(COALESCE(pc.address_neighborhood,'')) LIKE lower($3)
            OR lower(COALESCE(pc.address_city,'')) LIKE lower($3))
        ORDER BY pc.updated_at DESC LIMIT 30`,
      [ctx.environment,ctx.unitId,`%${search}%`,digits,`%${digits}%`],
    );
    return result.rows;
  });
}

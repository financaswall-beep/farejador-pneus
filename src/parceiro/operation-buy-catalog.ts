import type { PartnerContext } from './auth.js';
import { withPartnerContext } from './db.js';
import { env } from '../shared/config/env.js';

interface Offer {
  offer_key: string; measure: string; brand: string; tire_condition: string;
  vehicle_type: 'motorcycle' | 'car'; quantity_available: number; price_cents: string;
}

export async function getPartnerBuyCatalog(ctx: PartnerContext) {
  return withPartnerContext(ctx.partnerUnitId, async client => {
    const result = await client.query<Offer>(`SELECT offer_key,measure,brand,tire_condition,
      vehicle_type,quantity_available,price_cents FROM commerce.partner_wholesale_catalog()`);
    const schema=await client.query<{ready:boolean}>(`SELECT to_regprocedure('commerce.submit_partner_wholesale_request(text,jsonb)') IS NOT NULL AS ready`);
    return {
      checkout_enabled: env.WHOLESALE_FINANCE && schema.rows[0]?.ready===true,
      rows: result.rows.map(({ offer_key,measure,brand,tire_condition,vehicle_type,quantity_available,price_cents }) =>
        ({ offer_key,measure,brand,tire_condition,vehicle_type,quantity_available,price_cents: Number(price_cents) })),
    };
  });
}

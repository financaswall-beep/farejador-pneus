import type { PartnerContext } from './auth.js';
import { withPartnerContext } from './db.js';

interface Offer {
  measure: string; brand: string; tire_condition: string; vehicle_type: string | null;
  quantity_available: number; demand_count: number; last_demand_at: Date;
}

export async function getPartnerReplenishment(ctx: PartnerContext) {
  return withPartnerContext(ctx.partnerUnitId, async client => {
    const rows = (await client.query<Offer>('SELECT * FROM commerce.partner_replenishment_offers()')).rows;
    const first = rows[0];
    return {
      replenishment: first ? { measure: first.measure, demand_count: first.demand_count,
        quantity_available: rows.reduce((total, row) => total + row.quantity_available, 0),
        period_days: 7 } : null,
      rows: rows.map(({ measure, brand, tire_condition, vehicle_type, quantity_available }) =>
        ({ measure, brand, tire_condition, vehicle_type, quantity_available })),
    };
  });
}

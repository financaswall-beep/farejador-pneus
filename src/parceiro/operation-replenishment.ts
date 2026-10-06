import type { PartnerContext } from './auth.js';
import { withPartnerContext } from './db.js';

interface Offer {
  measure: string; brand: string; tire_condition: string; vehicle_type: string | null;
  quantity_available: number; demand_count: number; last_demand_at: Date;
}

export async function getPartnerReplenishment(ctx: PartnerContext) {
  return withPartnerContext(ctx.partnerUnitId, async client => {
    const rows = (await client.query<Offer>('SELECT * FROM commerce.partner_replenishment_offers()')).rows;
    const measures: Array<{ measure: string; demand_count: number; quantity_available: number }> = [];
    for (const row of rows) {
      const item = measures.find(item => item.measure === row.measure);
      if (item) item.quantity_available += row.quantity_available;
      else measures.push({ measure: row.measure, demand_count: row.demand_count, quantity_available: row.quantity_available });
    }
    const first = measures[0];
    return {
      replenishment: first ? { measure: first.measure, demand_count: first.demand_count,
        quantity_available: first.quantity_available, measures, period_days: 7 } : null,
      rows: rows.map(({ measure, brand, tire_condition, vehicle_type, quantity_available }) =>
        ({ measure, brand, tire_condition, vehicle_type, quantity_available })),
    };
  });
}

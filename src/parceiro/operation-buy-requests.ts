import { env } from '../shared/config/env.js';
import type { PartnerContext } from './auth.js';
import { withPartnerContext } from './db.js';

export interface BuyRequestInput {
  idempotency_key: string;
  items: Array<{offer_key:string;quantity:number;expected_price_cents:number}>;
}
export async function submitBuyRequest(ctx: PartnerContext, input: BuyRequestInput) {
  if (!env.WHOLESALE_FINANCE) throw new Error('wholesale_finance_required');
  return withPartnerContext(ctx.partnerUnitId, async client => {
    const row=await client.query<{result:Record<string,unknown>}>(
      'SELECT commerce.submit_partner_wholesale_request($1,$2::jsonb) AS result',
      [input.idempotency_key,JSON.stringify(input.items)]);
    return row.rows[0]!.result;
  });
}
export async function getBuyRequests(ctx: PartnerContext) {
  return withPartnerContext(ctx.partnerUnitId, async client => {
    const rows=await client.query<{row:Record<string,unknown>}>(
      'SELECT row FROM commerce.partner_wholesale_requests_for_unit() AS row');
    return {rows:rows.rows.map(r=>r.row)};
  });
}

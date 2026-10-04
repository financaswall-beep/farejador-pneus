import type { Pool } from 'pg';
import { env } from '../shared/config/env.js';
export async function assertStockConfirmationSchema(db:Pick<Pool,'query'>):Promise<void> {
  if(!env.PARTNER_STOCK_CONFIRMATION)return;
  const result=await db.query<{ready:boolean}>(`SELECT
    to_regclass('commerce.partner_stock_requests') IS NOT NULL AND
    to_regprocedure('commerce.answer_partner_stock_request(uuid,integer,boolean)') IS NOT NULL AS ready`);
  if(result.rows[0]?.ready!==true)throw new Error('required_schema_missing:0261_partner_stock_confirmation');
}

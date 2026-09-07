import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { safeCustomerDisplayName } from '../../shared/customer-name.js';
import { VIP_MIN_PURCHASES } from './queries-clientes-board.js';
import { customerOrdersSql, customerProfileSql, type CustomerDetailSource } from './customer-detail-sql.js';

interface Profile {
  name: string | null; phone: string | null; email: string | null; created_at: string;
  origin: string; address: string | null; unit_id: string | null; unit_name: string | null;
  lead_conversation_id?: string; chatwoot_account_id?: number | string;
  chatwoot_conversation_id?: number | string;
}
interface Order {
  id: string; order_number: string; total_amount: number; status: string; completed: boolean;
  fulfillment_mode: string; payment_method: string | null; occurred_at: string; unit_name: string | null;
  items: Array<{ label: string; quantity: number; unit_price: number }>;
}
interface History {
  purchases: number; total_spent: number; avg_ticket: number; last_purchase_at: string | null;
  history_total: number; last_address: string | null; last_unit_name: string | null; orders: Order[];
}

export async function getCustomerDetail(
  environment: 'prod' | 'test', source: CustomerDetailSource, id: string,
  options: { offset?: number; limit?: number } = {}, dbPool: Pool = defaultPool,
) {
  const profile = (await dbPool.query<Profile>(customerProfileSql[source], [environment,id])).rows[0];
  if (!profile) return null;
  const limit = Math.min(30, Math.max(1, options.limit ?? 10));
  const offset = Math.max(0, options.offset ?? 0);
  const args: unknown[] = [environment,id,limit,offset];
  if (source === 'parceiro') args.push(profile.unit_id);
  const history = (await dbPool.query<History>(customerOrdersSql(source),args)).rows[0]!;
  const address = history.last_address ?? profile.address;
  return {
    customer: {
      id: `${source}:${id}`,source,source_id:id,
      name: safeCustomerDisplayName(profile.name).name,phone:profile.phone,email:profile.email,
      created_at:profile.created_at,origin:profile.origin,
      unit_name:profile.unit_name ?? history.last_unit_name,
      lead_conversation_id:profile.lead_conversation_id ?? null,
      chatwoot_account_id:profile.chatwoot_account_id == null ? null : Number(profile.chatwoot_account_id),
      chatwoot_conversation_id:profile.chatwoot_conversation_id == null ? null : Number(profile.chatwoot_conversation_id),
      address,address_source:history.last_address ? 'order' : (address ? 'customer' : null),
      is_vip:history.purchases >= VIP_MIN_PURCHASES,vip_min_purchases:VIP_MIN_PURCHASES,
    },
    summary: { purchases:history.purchases,total_spent:history.total_spent,
      avg_ticket:history.avg_ticket,last_purchase_at:history.last_purchase_at },
    orders:history.orders,history_total:history.history_total,
    next_offset:offset + history.orders.length < history.history_total ? offset + history.orders.length : null,
  };
}

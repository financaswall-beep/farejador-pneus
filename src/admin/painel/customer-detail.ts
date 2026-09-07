import type { Pool,PoolClient } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { safeCustomerDisplayName } from '../../shared/customer-name.js';
import { env } from '../../shared/config/env.js';
import { cachedReverseGeocode } from '../../shared/geo/geo-cache.js';
import { logger } from '../../shared/logger.js';
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

interface LocationPin {
  coordinates_lat: string | number; coordinates_lng: string | number; observed_at: string;
}

async function loadSharedLeadLocation(
  environment:'prod'|'test',contactId:string,dbPool:Pool,
):Promise<{ label:string;estimated_address:string|null;observed_at:string;maps_url:string;source:'shared_pin' }|null> {
  try {
    const pin=(await dbPool.query<LocationPin>(
      `SELECT a.coordinates_lat,a.coordinates_lng,a.created_at::text AS observed_at
         FROM core.message_attachments a
         JOIN core.conversations cv ON cv.id=a.conversation_id AND cv.environment=a.environment
        WHERE a.environment=$1 AND cv.contact_id=$2 AND cv.deleted_at IS NULL
          AND a.file_type='location' AND a.coordinates_lat IS NOT NULL AND a.coordinates_lng IS NOT NULL
        ORDER BY a.created_at DESC,a.id DESC LIMIT 1`,[environment,contactId],
    )).rows[0];
    if(!pin)return null;
    const lat=Number(pin.coordinates_lat);const lng=Number(pin.coordinates_lng);
    if(!Number.isFinite(lat)||!Number.isFinite(lng))return null;
    const reverse=await cachedReverseGeocode(dbPool as unknown as PoolClient,{lat,lng},env.GOOGLE_MAPS_API_KEY,
      { requireFormattedAddress:true });
    const estimatedAddress=reverse?.formattedAddress
      || [reverse?.neighborhood,reverse?.municipio].filter(Boolean).join(', ')
      || null;
    const label=[reverse?.neighborhood,reverse?.municipio].filter(Boolean).join(' — ')
      || estimatedAddress || 'Localização compartilhada';
    return { label,estimated_address:estimatedAddress,observed_at:pin.observed_at,
      maps_url:`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${lat},${lng}`)}`,
      source:'shared_pin' };
  }catch(error){
    logger.warn({ error,contact_id:contactId },'customer detail: localização compartilhada indisponível');
    return null;
  }
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
  const sharedLocation=source==='chatwoot'?await loadSharedLeadLocation(environment,id,dbPool):null;
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
      shared_location:sharedLocation,
      is_vip:history.purchases >= VIP_MIN_PURCHASES,vip_min_purchases:VIP_MIN_PURCHASES,
    },
    summary: { purchases:history.purchases,total_spent:history.total_spent,
      avg_ticket:history.avg_ticket,last_purchase_at:history.last_purchase_at },
    orders:history.orders,history_total:history.history_total,
    next_offset:offset + history.orders.length < history.history_total ? offset + history.orders.length : null,
  };
}

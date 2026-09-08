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

interface LeadLocationCandidate {
  source: 'shared_pin' | 'typed';
  coordinates_lat: string | number | null;
  coordinates_lng: string | number | null;
  observed_at: string;
  fact_value: unknown;
}

type SharedLeadLocation = {
  label:string;estimated_address:string|null;observed_at:string;maps_url:string;
  source:'shared_pin'|'typed';
};

function cleanPart(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function loadLeadLocation(
  environment:'prod'|'test',contactId:string,dbPool:Pool,
):Promise<SharedLeadLocation|null> {
  try {
    const candidate=(await dbPool.query<LeadLocationCandidate>(
      `WITH candidates AS (
         SELECT 'shared_pin'::text AS source,a.coordinates_lat,a.coordinates_lng,
                a.created_at AS observed_at,NULL::jsonb AS fact_value,1 AS priority,a.id
           FROM core.message_attachments a
           JOIN core.conversations cv ON cv.id=a.conversation_id AND cv.environment=a.environment
          WHERE a.environment=$1 AND cv.contact_id=$2 AND cv.deleted_at IS NULL
            AND a.file_type='location' AND a.coordinates_lat IS NOT NULL AND a.coordinates_lng IS NOT NULL
         UNION ALL
         SELECT 'typed',NULL::numeric,NULL::numeric,COALESCE(f.observed_at,f.created_at),
                f.fact_value,0,f.id
           FROM analytics.conversation_facts f
           JOIN core.conversations cv ON cv.id=f.conversation_id AND cv.environment=f.environment
          WHERE f.environment=$1 AND cv.contact_id=$2 AND cv.deleted_at IS NULL
            AND f.fact_key='localizacao_lead' AND f.superseded_by IS NULL
            AND jsonb_typeof(f.fact_value)='object'
       )
       SELECT source,coordinates_lat,coordinates_lng,observed_at::text,fact_value
         FROM candidates ORDER BY observed_at DESC,priority DESC,id DESC LIMIT 1`,[environment,contactId],
    )).rows[0];
    if(!candidate)return null;
    if(candidate.source==='typed'){
      const value=candidate.fact_value && typeof candidate.fact_value==='object'
        ? candidate.fact_value as Record<string,unknown>:{};
      const text=cleanPart(value.texto_informado);
      if(!text)return null;
      const rua=cleanPart(value.rua);const numero=cleanPart(value.numero);
      const bairro=cleanPart(value.bairro);const municipio=cleanPart(value.municipio);
      const address=[rua,numero,bairro,municipio].filter(Boolean).join(', ')||text;
      const label=[bairro,municipio].filter(Boolean).join(' — ')||text;
      return { label,estimated_address:address,observed_at:candidate.observed_at,
        maps_url:`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`,
        source:'typed' };
    }
    const lat=Number(candidate.coordinates_lat);const lng=Number(candidate.coordinates_lng);
    if(!Number.isFinite(lat)||!Number.isFinite(lng))return null;
    const reverse=await cachedReverseGeocode(dbPool as unknown as PoolClient,{lat,lng},env.GOOGLE_MAPS_API_KEY,
      { requireFormattedAddress:true });
    const estimatedAddress=reverse?.formattedAddress
      || [reverse?.neighborhood,reverse?.municipio].filter(Boolean).join(', ')
      || null;
    const label=[reverse?.neighborhood,reverse?.municipio].filter(Boolean).join(' — ')
      || estimatedAddress || 'Localização compartilhada';
    return { label,estimated_address:estimatedAddress,observed_at:candidate.observed_at,
      maps_url:`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${lat},${lng}`)}`,
      source:'shared_pin' };
  }catch(error){
    logger.warn({ error,contact_id:contactId },'customer detail: localização do lead indisponível');
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
  const sharedLocation=source==='chatwoot'?await loadLeadLocation(environment,id,dbPool):null;
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

import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { normalizeBrazilianPhone } from '../../shared/phone.js';
import { sourceAuthorityRank } from './customer-identity-sources.js';
import type {
  CursorPage, CustomerIdentityMetrics, CustomerIdentityRow, CustomerIdentitySource,
  CustomerSourceType,
} from './customer-identity-types.js';

interface IdentityDbRow {
  id: string; entity_type: CustomerIdentityRow['entity_type']; classification: string | null;
  is_vip: boolean; created_at: string;
}

function encodeCursor(id: string): string { return Buffer.from(id).toString('base64url'); }
function decodeCursor(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    return /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(decoded) ? decoded : null;
  } catch { return null; }
}

const sourceProjectionSql = `
  SELECT l.id::text link_id,l.identity_id::text,'chatwoot_contact'::text source_type,c.id::text source_id,
         c.environment,'matrix'::text owner_scope,NULL::text partner_unit_id,
         COALESCE(NULLIF(c.name,''),'Cliente sem nome') name,c.phone_e164 phone,c.email,
         NULL::text document_number,'person'::text entity_type,false is_vip,c.updated_at::text
    FROM commerce.customer_identity_links l JOIN core.contacts c ON c.id=l.source_id AND c.environment=l.environment
   WHERE l.environment=$1 AND l.identity_id=ANY($2::uuid[]) AND l.source_type='chatwoot_contact' AND l.ended_at IS NULL AND c.deleted_at IS NULL
  UNION ALL
  SELECT l.id::text,l.identity_id::text,'walkin_customer',c.id::text,c.environment,'matrix',NULL::text,
         COALESCE(NULLIF(c.name,''),'Cliente sem nome'),c.phone_e164,c.email,NULL::text,'unknown',false,c.updated_at::text
    FROM commerce.customer_identity_links l JOIN commerce.customers c ON c.id=l.source_id AND c.environment=l.environment
   WHERE l.environment=$1 AND l.identity_id=ANY($2::uuid[]) AND l.source_type='walkin_customer' AND l.ended_at IS NULL AND c.deleted_at IS NULL
  UNION ALL
  SELECT l.id::text,l.identity_id::text,'partner_customer',pc.id::text,pc.environment,'partner_unit',l.partner_unit_id::text,
         pc.name,pc.phone,NULL::text,pc.cpf,'person',pc.is_vip,pc.updated_at::text
    FROM commerce.customer_identity_links l JOIN commerce.partner_customers pc ON pc.id=l.source_id AND pc.environment=l.environment
   WHERE l.environment=$1 AND l.identity_id=ANY($2::uuid[]) AND l.source_type='partner_customer' AND l.ended_at IS NULL AND pc.deleted_at IS NULL
  UNION ALL
  SELECT l.id::text,l.identity_id::text,'wholesale_customer',wc.id::text,wc.environment,'matrix',NULL::text,
         wc.name,wc.phone,NULL::text,NULL::text,'tire_shop',false,wc.updated_at::text
    FROM commerce.customer_identity_links l JOIN commerce.wholesale_customers wc ON wc.id=l.source_id AND wc.environment=l.environment
   WHERE l.environment=$1 AND l.identity_id=ANY($2::uuid[]) AND l.source_type='wholesale_customer' AND l.ended_at IS NULL AND wc.deleted_at IS NULL
  UNION ALL
  SELECT l.id::text,l.identity_id::text,'network_partner',p.id::text,p.environment,'matrix',NULL::text,
         p.trade_name,p.whatsapp_phone,p.email,p.document_number,'partner',false,p.updated_at::text
    FROM commerce.customer_identity_links l JOIN network.partners p ON p.id=l.source_id AND p.environment=l.environment
   WHERE l.environment=$1 AND l.identity_id=ANY($2::uuid[]) AND l.source_type='network_partner' AND l.ended_at IS NULL AND p.deleted_at IS NULL
  UNION ALL
  SELECT l.id::text,l.identity_id::text,'matriz_collaborator',mc.id::text,mc.environment,'matrix',NULL::text,
         mc.display_name,NULL::text,NULL::text,NULL::text,'collaborator',false,mc.created_at::text
    FROM commerce.customer_identity_links l JOIN network.matriz_collaborators mc ON mc.id=l.source_id AND mc.environment=l.environment
   WHERE l.environment=$1 AND l.identity_id=ANY($2::uuid[]) AND l.source_type='matriz_collaborator' AND l.ended_at IS NULL AND mc.revoked_at IS NULL`;

const metricsSql = `WITH retail_orders AS (
  SELECT DISTINCT ON (l.identity_id,o.id) l.identity_id,o.id order_id,o.total_amount amount,o.created_at occurred_at,
         COALESCE(x.profit,0) profit,COALESCE(x.pending,0)::int pending
    FROM commerce.customer_identity_links l
    JOIN commerce.orders o ON o.environment=l.environment AND o.status<>'cancelled'
     AND ((l.source_type='chatwoot_contact' AND o.contact_id=l.source_id)
       OR (l.source_type='walkin_customer' AND o.customer_id=l.source_id))
    LEFT JOIN LATERAL (
      SELECT sum(((oi.unit_price-oi.matriz_unit_cost)*oi.quantity)-oi.discount_amount)
               FILTER(WHERE oi.matriz_unit_cost IS NOT NULL) profit,
             count(*) FILTER(WHERE oi.matriz_unit_cost IS NULL) pending
        FROM commerce.order_items oi WHERE oi.order_id=o.id
    ) x ON true
   WHERE l.environment=$1 AND l.identity_id=ANY($2::uuid[]) AND l.ended_at IS NULL
), partner_orders AS (
  SELECT l.identity_id,po.id order_id,po.total_amount amount,
         (CASE WHEN po.fulfillment_mode='delivery' THEN po.delivered_at ELSE COALESCE(po.retrieved_at,po.created_at) END) occurred_at,
         COALESCE(x.profit,0) profit,COALESCE(x.pending,0)::int pending
    FROM commerce.customer_identity_links l
    JOIN commerce.partner_orders po ON po.environment=l.environment AND po.customer_id=l.source_id
      AND po.status<>'cancelled' AND po.deleted_at IS NULL
      AND NOT (po.fulfillment_mode='delivery' AND po.delivery_status<>'delivered') AND NOT po.awaiting_pickup
    LEFT JOIN LATERAL (
      SELECT sum((poi.quantity*poi.unit_price-poi.discount_amount)-(poi.quantity*poi.unit_cost_snapshot))
               FILTER(WHERE poi.cost_status='known') profit,
             count(*) FILTER(WHERE poi.cost_status='pending') pending
        FROM commerce.partner_order_items poi WHERE poi.order_id=po.id
    ) x ON true
   WHERE l.environment=$1 AND l.identity_id=ANY($2::uuid[]) AND l.source_type='partner_customer' AND l.ended_at IS NULL
), wholesale_orders AS (
  SELECT l.identity_id,wo.id order_id,wo.total_amount amount,wo.sold_at occurred_at,
         COALESCE(sum(wi.line_profit) FILTER(WHERE wi.line_profit IS NOT NULL),0) profit,
         count(*) FILTER(WHERE wi.line_profit IS NULL)::int pending
    FROM commerce.customer_identity_links l
    JOIN commerce.wholesale_orders wo ON wo.environment=l.environment AND wo.buyer_id=l.source_id AND wo.status='confirmed'
    LEFT JOIN commerce.wholesale_order_items wi ON wi.order_id=wo.id
   WHERE l.environment=$1 AND l.identity_id=ANY($2::uuid[]) AND l.source_type='wholesale_customer' AND l.ended_at IS NULL
   GROUP BY l.identity_id,wo.id
), transactions AS (
  SELECT identity_id,'retail:'||order_id tx,amount,occurred_at,profit,pending FROM retail_orders
  UNION ALL SELECT identity_id,'partner:'||order_id,amount,occurred_at,profit,pending FROM partner_orders
  UNION ALL SELECT identity_id,'wholesale:'||order_id,amount,occurred_at,profit,pending FROM wholesale_orders
)
SELECT identity_id::text,count(*)::int purchases,COALESCE(sum(amount),0)::float8 total_spent,
       COALESCE(avg(amount),0)::float8 avg_ticket,
       CASE WHEN sum(pending)>0 THEN NULL ELSE COALESCE(sum(profit),0)::float8 END gross_profit,
       COALESCE(sum(pending),0)::int pending_cost_items,
       min(occurred_at)::text first_purchase_at,max(occurred_at)::text last_purchase_at
  FROM transactions GROUP BY identity_id`;

function conflicts(sources: CustomerIdentitySource[]): CustomerIdentityRow['conflicts'] {
  const distinct = (field: 'name' | 'phone' | 'email' | 'document_number'): boolean => {
    const values = sources.map((source) => field === 'phone' ? normalizeBrazilianPhone(source.phone) : source[field]?.trim().toLowerCase())
      .filter((value): value is string => Boolean(value));
    return new Set(values).size > 1;
  };
  return (['name','phone','email','document_number'] as const).filter(distinct);
}

const emptyMetrics = (): CustomerIdentityMetrics => ({ purchases: 0,total_spent: 0,avg_ticket: 0,
  gross_profit: 0,pending_cost_items: 0,first_purchase_at: null,last_purchase_at: null });

export async function getClientesPainelV2(
  options: { cursor?: string; limit?: number; filter?: string; identityId?: string } = {},
  environment: 'prod' | 'test' = env.FAREJADOR_ENV, dbPool: Pool = defaultPool,
): Promise<CursorPage<CustomerIdentityRow>> {
  const limit = Math.min(Math.max(options.limit ?? 50,1),200);
  const cursor = decodeCursor(options.cursor);
  if (options.cursor && !cursor) throw new Error('invalid_cursor');
  const filter = options.filter?.trim() || null;
  const identities = await dbPool.query<IdentityDbRow>(
    `SELECT DISTINCT ci.id::text,ci.entity_type,ci.classification,ci.is_vip,ci.created_at::text
       FROM commerce.customer_identities ci
       JOIN commerce.customer_identity_links l ON l.identity_id=ci.id AND l.environment=ci.environment AND l.ended_at IS NULL
       LEFT JOIN core.contacts sc ON l.source_type='chatwoot_contact' AND sc.id=l.source_id AND sc.deleted_at IS NULL
       LEFT JOIN commerce.customers sw ON l.source_type='walkin_customer' AND sw.id=l.source_id AND sw.deleted_at IS NULL
       LEFT JOIN commerce.partner_customers sp ON l.source_type='partner_customer' AND sp.id=l.source_id AND sp.deleted_at IS NULL
       LEFT JOIN commerce.wholesale_customers sx ON l.source_type='wholesale_customer' AND sx.id=l.source_id AND sx.deleted_at IS NULL
       LEFT JOIN network.partners sn ON l.source_type='network_partner' AND sn.id=l.source_id AND sn.deleted_at IS NULL
       LEFT JOIN network.matriz_collaborators sm ON l.source_type='matriz_collaborator' AND sm.id=l.source_id AND sm.revoked_at IS NULL
      WHERE ci.environment=$1 AND ci.status='active' AND ($2::uuid IS NULL OR ci.id>$2::uuid)
        AND ($5::uuid IS NULL OR ci.id=$5::uuid)
        AND ($3::text IS NULL OR lower(concat_ws(' ',sc.name,sc.phone_e164,sc.email,
              sw.name,sw.phone_e164,sw.email,sp.name,sp.phone,sp.cpf,sx.name,sx.phone,
              sn.trade_name,sn.whatsapp_phone,sn.email,sn.document_number,sm.display_name)) LIKE '%'||lower($3)||'%')
      ORDER BY ci.id::text LIMIT $4`, [environment,cursor,filter,limit + 1,options.identityId ?? null]);
  const hasNext = identities.rows.length > limit;
  const selected = identities.rows.slice(0,limit);
  const ids = selected.map((row) => row.id);
  if (ids.length === 0) return { rows: [], next_cursor: null };
  const [sourceResult, metricResult] = await Promise.all([
    dbPool.query<CustomerIdentitySource>(sourceProjectionSql, [environment,ids]),
    dbPool.query<CustomerIdentityMetrics & { identity_id: string }>(metricsSql,[environment,ids]),
  ]);
  const sourcesByIdentity = new Map<string,CustomerIdentitySource[]>();
  for (const source of sourceResult.rows) {
    const group = sourcesByIdentity.get(source.identity_id) ?? [];
    group.push(source); sourcesByIdentity.set(source.identity_id,group);
  }
  const metricsByIdentity = new Map(metricResult.rows.map((row) => [row.identity_id,row]));
  const rows = selected.map((identity): CustomerIdentityRow => {
    const sources = (sourcesByIdentity.get(identity.id) ?? [])
      .sort((a,b) => sourceAuthorityRank[a.source_type as CustomerSourceType]-sourceAuthorityRank[b.source_type as CustomerSourceType]);
    const authority = sources[0];
    const scopes = new Set(sources.map((source) => source.owner_scope));
    return { ...identity,name: authority?.name ?? 'Cliente sem nome',phone: authority?.phone ?? null,
      email: authority?.email ?? null,document_number: authority?.document_number ?? null,
      scope: scopes.size > 1 ? 'mixed' : (sources[0]?.owner_scope ?? 'matrix'),sources,
      conflicts: conflicts(sources),metrics: metricsByIdentity.get(identity.id) ?? emptyMetrics() };
  });
  const last = rows.at(-1);
  return { rows,next_cursor: hasNext && last ? encodeCursor(last.id) : null };
}

export async function getClientePainelV2ById(
  id: string, environment: 'prod' | 'test' = env.FAREJADOR_ENV, dbPool: Pool = defaultPool,
): Promise<CustomerIdentityRow | null> {
  const page = await getClientesPainelV2({ limit:1,identityId:id },environment,dbPool);
  return page.rows[0] ?? null;
}

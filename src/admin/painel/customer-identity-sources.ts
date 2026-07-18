import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import type { CursorPage, CustomerSourceRecord, CustomerSourceType } from './customer-identity-types.js';

type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

interface SourceCursor { source_type: CustomerSourceType; source_id: string }

function encodeCursor(cursor: SourceCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(value: string | undefined): SourceCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<SourceCursor>;
    if (typeof parsed.source_type !== 'string' || typeof parsed.source_id !== 'string') return null;
    return parsed as SourceCursor;
  } catch { return null; }
}

const allSourcesSql = `WITH source_rows AS (
  SELECT 'chatwoot_contact'::text source_type, c.id source_id, c.environment,
         'matrix'::text owner_scope, NULL::uuid partner_unit_id,
         COALESCE(NULLIF(c.name,''),'Cliente sem nome') name, c.phone_e164 phone, c.email,
         NULL::text document_number, 'person'::text entity_type, false is_vip, c.updated_at
    FROM core.contacts c WHERE c.environment=$1 AND c.deleted_at IS NULL
  UNION ALL
  SELECT 'walkin_customer', c.id, c.environment, 'matrix', NULL::uuid,
         COALESCE(NULLIF(c.name,''),'Cliente sem nome'), c.phone_e164, c.email,
         NULL::text, 'unknown', false, c.updated_at
    FROM commerce.customers c WHERE c.environment=$1 AND c.deleted_at IS NULL
  UNION ALL
  SELECT 'partner_customer', pc.id, pc.environment, 'partner_unit', pu.id,
         pc.name, pc.phone, NULL::text, pc.cpf, 'person', pc.is_vip, pc.updated_at
    FROM commerce.partner_customers pc
    JOIN network.partner_units pu ON pu.environment=pc.environment AND pu.unit_id=pc.unit_id AND pu.deleted_at IS NULL
   WHERE pc.environment=$1 AND pc.deleted_at IS NULL
  UNION ALL
  SELECT 'wholesale_customer', wc.id, wc.environment, 'matrix', NULL::uuid,
         wc.name, wc.phone, NULL::text, NULL::text, 'tire_shop', false, wc.updated_at
    FROM commerce.wholesale_customers wc WHERE wc.environment=$1 AND wc.deleted_at IS NULL
  UNION ALL
  SELECT 'network_partner', p.id, p.environment, 'matrix', NULL::uuid,
         p.trade_name, p.whatsapp_phone, p.email, p.document_number, 'partner', false, p.updated_at
    FROM network.partners p WHERE p.environment=$1 AND p.deleted_at IS NULL
  UNION ALL
  SELECT 'matriz_collaborator', mc.id, mc.environment, 'matrix', NULL::uuid,
         mc.display_name, NULL::text, NULL::text, NULL::text, 'collaborator', false, mc.created_at
    FROM network.matriz_collaborators mc WHERE mc.environment=$1 AND mc.revoked_at IS NULL
)
SELECT source_type, source_id::text, environment, owner_scope, partner_unit_id::text,
       name, phone, email, document_number, entity_type, is_vip, updated_at::text
  FROM source_rows
 WHERE ($2::text IS NULL OR (source_type, source_id) > ($2::text, $3::uuid))
   AND ($4::text IS NULL OR lower(concat_ws(' ',name,phone,email,document_number)) LIKE '%'||lower($4)||'%')
 ORDER BY source_type, source_id
 LIMIT $5`;

export async function listCustomerSources(
  environment: 'prod' | 'test',
  options: { cursor?: string; limit?: number; filter?: string } = {},
  db: Queryable = defaultPool,
): Promise<CursorPage<CustomerSourceRecord>> {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
  const cursor = decodeCursor(options.cursor);
  if (options.cursor && !cursor) throw new Error('invalid_cursor');
  const result = await db.query<CustomerSourceRecord>(allSourcesSql, [
    environment, cursor?.source_type ?? null, cursor?.source_id ?? null,
    options.filter?.trim() || null, limit + 1,
  ]);
  const hasNext = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const last = rows.at(-1);
  return {
    rows,
    next_cursor: hasNext && last
      ? encodeCursor({ source_type: last.source_type, source_id: last.source_id }) : null,
  };
}

export async function getLinkedCustomerSources(
  environment: 'prod' | 'test', identityIds: string[], db: Queryable = defaultPool,
): Promise<CustomerSourceRecord[]> {
  if (identityIds.length === 0) return [];
  const result = await db.query<CustomerSourceRecord>(
    `WITH selected AS (${allSourcesSql.replace('LIMIT $5', 'LIMIT 1000000')})
     SELECT s.* FROM selected s
     JOIN commerce.customer_identity_links l
       ON l.environment=s.environment AND l.source_type=s.source_type AND l.source_id=s.source_id::uuid
      AND l.ended_at IS NULL
    WHERE l.identity_id=ANY($6::uuid[])
    ORDER BY l.identity_id,s.source_type,s.source_id`,
    [environment, null, null, null, 1000000, identityIds],
  );
  return result.rows;
}

export const sourceAuthorityRank: Record<CustomerSourceType, number> = {
  partner_customer: 1,
  walkin_customer: 2,
  chatwoot_contact: 3,
  wholesale_customer: 4,
  network_partner: 5,
  matriz_collaborator: 6,
};

import type { Pool, PoolClient } from 'pg';
import { pool } from '../../persistence/db.js';
import { normalizeCheckoutPhone } from '../../shared/phone.js';

export type SaleCustomerRef = { source: 'balcao' | 'chatwoot'; id: string };
export interface SaleCustomerInput {
  customer_ref?: SaleCustomerRef | null;
  customer_mode?: 'existing' | 'new' | 'anonymous';
  customer_name?: string | null;
  customer_phone?: string | null;
}
export const cleanCustomerText = (value?: string | null) => value?.trim().replace(/\s+/g, ' ') || null;

export async function searchSaleCustomers(environment: 'prod' | 'test', query: string, db: Pick<Pool, 'query'> = pool) {
  const text = cleanCustomerText(query) ?? '';
  if (text.length < 2) return { rows: [] };
  const digits = text.replace(/\D/g, '');
  const phone = normalizeCheckoutPhone(text);
  const result = await db.query(`WITH candidates AS (
    SELECT 'balcao'::text source,id,name,phone_e164 phone FROM commerce.customers
      WHERE environment=$1 AND deleted_at IS NULL
    UNION ALL SELECT 'chatwoot',id,name,phone_e164 FROM core.contacts
      WHERE environment=$1 AND deleted_at IS NULL
  ) SELECT source,id,name,phone FROM candidates
    WHERE strpos(lower(COALESCE(name,'')),lower($2))>0
      OR ($3<>'' AND strpos(regexp_replace(COALESCE(phone,''),'[^0-9]','','g'),$3)>0)
      OR ($4::text IS NOT NULL AND phone=$4)
    ORDER BY (phone=$4) DESC NULLS LAST,name NULLS LAST,source,id LIMIT 20`,
  [environment,text,digits,phone]);
  return { rows: result.rows };
}

/** Seleção explícita preserva o cadastro. Nome igual nunca identifica uma pessoa. */
export async function resolveSaleCustomer(client: PoolClient, environment: 'prod' | 'test', input: SaleCustomerInput) {
  if (input.customer_mode === 'anonymous') {
    if (input.customer_ref || cleanCustomerText(input.customer_name) || cleanCustomerText(input.customer_phone)) {
      throw new Error('sale_customer_mode_invalid');
    }
    // O contrato de orders exige uma parte. Registro sem nome/telefone não identifica uma pessoa.
    const row = (await client.query(`INSERT INTO commerce.customers(environment,name,phone_e164,source,notes)
      VALUES ($1,NULL,NULL,'walkin','Venda sem identificação') RETURNING id`, [environment])).rows[0];
    return { customerId: row.id, contactId: null, name: null, phone: null };
  }
  if (input.customer_ref && input.customer_mode && input.customer_mode !== 'existing') throw new Error('sale_customer_mode_invalid');
  if (input.customer_ref) {
    const { source, id } = input.customer_ref;
    const table = source === 'balcao' ? 'commerce.customers' : 'core.contacts';
    const row = (await client.query(`SELECT id,name,phone_e164 phone FROM ${table}
      WHERE environment=$1 AND id=$2 AND deleted_at IS NULL FOR SHARE`, [environment,id])).rows[0];
    if (!row) throw new Error('sale_customer_not_found');
    return { customerId: source === 'balcao' ? row.id : null,
      contactId: source === 'chatwoot' ? row.id : null, name: row.name, phone: row.phone };
  }
  if (input.customer_mode === 'existing') throw new Error('sale_customer_required');
  const name = cleanCustomerText(input.customer_name);
  const rawPhone = cleanCustomerText(input.customer_phone);
  const phone = normalizeCheckoutPhone(rawPhone);
  if (rawPhone && !phone) throw new Error('sale_customer_phone_invalid');
  if (input.customer_mode === 'new' && !name) throw new Error('sale_customer_name_required');
  if (phone) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`walkin-customer:${environment}:${phone}`]);
    const rows = (await client.query(`SELECT id,name,phone_e164 phone FROM commerce.customers
      WHERE environment=$1 AND phone_e164=$2 AND deleted_at IS NULL ORDER BY updated_at DESC,id LIMIT 1 FOR SHARE`,
    [environment,phone])).rows;
    const contact = input.customer_mode === 'new' && (await client.query(`SELECT id FROM core.contacts
      WHERE environment=$1 AND phone_e164=$2 AND deleted_at IS NULL LIMIT 1`, [environment,phone])).rows[0];
    if (input.customer_mode === 'new' && (rows.length || contact)) throw new Error('sale_customer_phone_exists');
    if (rows[0]) return { customerId: rows[0].id, contactId: null, name: rows[0].name, phone: rows[0].phone };
  }
  const row = (await client.query(`INSERT INTO commerce.customers(environment,name,phone_e164,source)
    VALUES ($1,COALESCE($2,'Cliente Balcao'),$3,'walkin') RETURNING id`, [environment,name,phone])).rows[0];
  return { customerId: row.id, contactId: null, name, phone };
}

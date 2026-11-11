import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { customerProfileSql, type CustomerDetailSource } from './customer-detail-sql.js';
import type { RegistryFields } from './customer-registry-schema.js';

export interface RegistryRow extends RegistryFields {
  source: CustomerDetailSource; source_id: string; version: number;
}
const fields = ['name','commercial_profile','phone','email','document_number','postal_code','street','number',
  'complement','neighborhood','city','state'] as const;

export async function readCustomerRegistry(environment: string, db: Pool = pool): Promise<Map<string,RegistryRow>> {
  if (!env.MATRIZ_CUSTOMER_REGISTRY) return new Map();
  const result = await db.query<RegistryRow>(`SELECT * FROM commerce.customer_registry WHERE environment=$1`,[environment]);
  return new Map(result.rows.map(row => [`${row.source}:${row.source_id}`,row]));
}
export async function readRegistryEntry(environment: string, source: CustomerDetailSource, id: string, db: Pool = pool) {
  if (!env.MATRIZ_CUSTOMER_REGISTRY) return null;
  return (await db.query<RegistryRow>(`SELECT * FROM commerce.customer_registry
    WHERE environment=$1 AND source=$2 AND source_id=$3`,[environment,source,id])).rows[0] ?? null;
}
export async function customerRegistryForIdentity(environment: string, identityId: string, db: Pool = pool) {
  // Privacidade deve encontrar as revisões mesmo depois de desativar a interface.
  const available = await db.query<{relation:string|null}>("SELECT to_regclass('commerce.customer_registry')::text AS relation");
  if (!available.rows[0]?.relation) return [];
  return (await db.query<Record<string,unknown>>(`SELECT r.source,r.source_id,r.name,r.phone,r.email,
    r.commercial_profile,r.document_number,r.postal_code,r.street,r.number,r.complement,r.neighborhood,r.city,r.state
    FROM commerce.customer_registry r JOIN commerce.customer_identity_links l ON l.environment=r.environment
      AND l.source_id=r.source_id AND l.ended_at IS NULL AND r.source=CASE l.source_type
        WHEN 'chatwoot_contact' THEN 'chatwoot' WHEN 'walkin_customer' THEN 'balcao'
        WHEN 'partner_customer' THEN 'parceiro' WHEN 'wholesale_customer' THEN 'atacado' END
    WHERE r.environment=$1 AND l.identity_id=$2`,[environment,identityId])).rows;
}

async function persist(client: PoolClient, environment: string, source: CustomerDetailSource, id: string,
  input: RegistryFields, actor: string, expectedVersion: number) {
  const previous = (await client.query<RegistryRow>(`SELECT * FROM commerce.customer_registry
    WHERE environment=$1 AND source=$2 AND source_id=$3 FOR UPDATE`,[environment,source,id])).rows[0];
  if ((previous?.version ?? 0) !== expectedVersion) throw new Error('registry_version_conflict');
  const changed = fields.filter(key => !previous || previous[key] !== input[key]);
  if (!changed.length) return previous!;
  const version = expectedVersion + 1;
  const args = [environment,source,id,...fields.map(key => input[key]),version,actor];
  const placeholders = args.map((_,i) => `$${i+1}`).join(',');
  const updated = (await client.query<RegistryRow>(`INSERT INTO commerce.customer_registry
    (environment,source,source_id,${fields.join(',')},version,updated_by) VALUES (${placeholders})
    ON CONFLICT (environment,source,source_id) DO UPDATE SET
      ${fields.map(key => `${key}=EXCLUDED.${key}`).join(',')},version=EXCLUDED.version,
      updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`,args)).rows[0]!;
  await client.query(`INSERT INTO commerce.customer_registry_audit(environment,source,source_id,version,actor,changed_fields)
    VALUES($1,$2,$3,$4,$5,$6)`,[environment,source,id,version,actor,changed]);
  return updated;
}
export async function updateCustomerRegistry(environment: string, source: CustomerDetailSource, id: string,
  input: RegistryFields, expectedVersion: number, actor: string, db: Pool = pool) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(customerProfileSql[source]+' FOR UPDATE OF c',[environment,id]);
    if (!found.rows.length) throw new Error('customer_not_found');
    const row = await persist(client,environment,source,id,input,actor,expectedVersion);
    await client.query('COMMIT');
    return row;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export async function createCustomerRegistry(environment: string, input: RegistryFields,
  idempotencyKey: string, actor: string, db: Pool = pool) {
  const client = await db.connect();
  const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`customer-registry:${environment}:${idempotencyKey}`]);
    const previous = (await client.query<{source:CustomerDetailSource;source_id:string;request_hash:string}>(
      `SELECT * FROM commerce.customer_registry_requests WHERE environment=$1 AND idempotency_key=$2`,[environment,idempotencyKey])).rows[0];
    if (previous) {
      if (previous.request_hash !== hash) throw new Error('idempotency_conflict');
      const found = await client.query(customerProfileSql[previous.source],[environment,previous.source_id]);
      if (!found.rows.length) throw new Error('customer_not_found');
      await client.query('COMMIT');
      return {source:previous.source,source_id:previous.source_id};
    }
    const source = input.commercial_profile === 'atacado' ? 'atacado' : 'balcao';
    if (input.phone) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`customer-registry-phone:${environment}:${input.phone}`]);
      const duplicate = await client.query(`SELECT 1 FROM (
        SELECT phone_e164 AS phone FROM core.contacts WHERE environment=$1 AND deleted_at IS NULL
        UNION ALL SELECT phone_e164 FROM commerce.customers WHERE environment=$1 AND deleted_at IS NULL
        UNION ALL SELECT phone FROM commerce.wholesale_customers WHERE environment=$1 AND deleted_at IS NULL
        UNION ALL SELECT phone FROM commerce.customer_registry WHERE environment=$1
      ) phones WHERE regexp_replace(phone,'[^0-9]','','g') IN ($2,$3) LIMIT 1`,[environment,input.phone.slice(1),input.phone.slice(3)]);
      if (duplicate.rows.length) throw new Error('customer_phone_exists');
    }
    const sql = source === 'atacado'
      ? `INSERT INTO commerce.wholesale_customers(environment,name,phone) VALUES($1,$2,$3) RETURNING id`
      : `INSERT INTO commerce.customers(environment,name,phone_e164,email) VALUES($1,$2,$3,$4) RETURNING id`;
    const args = source === 'atacado' ? [environment,input.name,input.phone] : [environment,input.name,input.phone,input.email || null];
    const id = (await client.query<{id:string}>(sql,args)).rows[0]!.id;
    await persist(client,environment,source,id,input,actor,0);
    await client.query(`INSERT INTO commerce.customer_registry_requests(environment,idempotency_key,request_hash,source,source_id)
      VALUES($1,$2,$3,$4,$5)`,[environment,idempotencyKey,hash,source,id]);
    await client.query('COMMIT');
    return {source,source_id:id};
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { pool } from '../persistence/db.js';
import { env } from './config/env.js';

type Environment = 'prod' | 'test';
const sourceUrl = z.string().trim().max(2000).url().refine(value => {
  const url = URL.parse(value);
  return url !== null && ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
}, 'market_reference_invalid');

export const marketReferenceSchema = z.object({
  product_id: z.string().uuid(),
  model: z.string().trim().min(1).max(120),
  amount: z.number().positive().max(9_999_999.99).refine(value =>
    Math.abs(value * 100 - Math.round(value * 100)) < 1e-7, 'market_reference_invalid'),
  sources: z.array(sourceUrl).min(1).max(12).refine(urls =>
    new Set(urls.map(url => URL.parse(url)?.href.split('#')[0])).size === urls.length, 'market_reference_invalid'),
  observed_on: z.string().date(),
  valid_until: z.string().date().nullable(),
  bot_enabled: z.boolean(),
}).strict().refine(data => (!data.bot_enabled || data.valid_until !== null)
  && (!data.valid_until || data.valid_until >= data.observed_on), 'market_reference_dates_invalid');

export type MarketReferenceInput = z.infer<typeof marketReferenceSchema>;
export interface MarketReference extends MarketReferenceInput {
  id: string;
  actor_label: string;
  recorded_at: string;
}

const columns = `id::text,product_id,model,amount::float8,sources,observed_on::text,
  valid_until::text,bot_enabled,actor_label,to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') recorded_at`;
const specSnapshot = `jsonb_build_array(p.brand,s.tire_size,s.tread_pattern,s.load_index,s.speed_rating,s.construction,s.vehicle_type)`;
const shopDate = "(now() AT TIME ZONE 'America/Sao_Paulo')::date";

export async function getMarketReference(productId: string, environment: Environment = env.FAREJADOR_ENV,
  db: Pool | PoolClient = pool): Promise<MarketReference | null> {
  const result = await db.query<MarketReference>(
    `SELECT ${columns} FROM commerce.catalog_market_references
     WHERE environment=$1 AND product_id=$2 ORDER BY catalog_market_references.id DESC LIMIT 1`,
    [environment,productId]);
  return result.rows[0] ?? null;
}

export async function setMarketReference(input: MarketReferenceInput, actor: string,
  environment: Environment = env.FAREJADOR_ENV, db: Pool = pool, transactionClient?: PoolClient): Promise<MarketReference> {
  const parsed = marketReferenceSchema.safeParse(input);
  if (!parsed.success) throw new Error('market_reference_invalid');
  const data = parsed.data;
  const client = transactionClient ?? await db.connect();
  try {
    if (!transactionClient) await client.query('BEGIN');
    const {rows} = await client.query<{matches:boolean; valid_dates:boolean; spec:unknown}>(
      `SELECT ${specSnapshot} AS spec,
         s.vehicle_type='car' AND lower(btrim(s.tread_pattern)) = lower(btrim($3::text)) AS matches,
         ($4::date <= ${shopDate} AND (NOT $5::boolean OR $6::date >= ${shopDate})) AS valid_dates
       FROM commerce.products p JOIN commerce.tire_specs s ON s.environment=p.environment AND s.product_id=p.id
       WHERE p.id=$2 AND p.environment=$1 AND p.product_type='tire' AND p.deleted_at IS NULL AND NOT p.partner_generic
       FOR UPDATE OF p,s`, [environment,data.product_id,data.model,data.observed_on,data.bot_enabled,data.valid_until]);
    if (!rows[0]) throw new Error('catalog_product_not_found');
    if (!rows[0].valid_dates) throw new Error('market_reference_dates_invalid');
    if (data.bot_enabled && !rows[0].matches) throw new Error('market_reference_model_mismatch');
    const values = [environment,data.product_id,data.model,data.amount,data.sources,data.observed_on,
      data.valid_until,data.bot_enabled,JSON.stringify(rows[0].spec),actor];
    const previous = await client.query<MarketReference>(`SELECT ${columns} FROM (
      SELECT * FROM commerce.catalog_market_references WHERE environment=$1 AND product_id=$2 ORDER BY id DESC LIMIT 1
    ) latest WHERE model=$3 AND amount=$4 AND sources=$5 AND observed_on=$6
      AND valid_until IS NOT DISTINCT FROM $7 AND bot_enabled=$8 AND product_spec=$9`, values.slice(0,9));
    const record = previous.rows[0] ?? (await client.query<MarketReference>(
      `INSERT INTO commerce.catalog_market_references
       (environment,product_id,model,amount,sources,observed_on,valid_until,bot_enabled,product_spec,actor_label)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${columns}`, values)).rows[0]!;
    if (!transactionClient) await client.query('COMMIT');
    return record;
  } catch (err) {
    if (!transactionClient) await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    if (!transactionClient) client.release();
  }
}

export async function readApprovedMarketReference(db: PoolClient, environment: Environment, productId: string) {
  const {rows} = await db.query<{amount:number;model:string;observed_on:string;comparison:'cotacao'|'media'}>(
    `SELECT r.amount::float8,r.model,r.observed_on::text,
       CASE WHEN cardinality(r.sources)=1 THEN 'cotacao' ELSE 'media' END AS comparison
     FROM (SELECT * FROM commerce.catalog_market_references WHERE environment=$1 AND product_id=$2
           ORDER BY id DESC LIMIT 1) r
     JOIN commerce.products p ON p.environment=r.environment AND p.id=r.product_id
     JOIN commerce.tire_specs s ON s.environment=r.environment AND s.product_id=r.product_id
     WHERE r.bot_enabled AND ${shopDate} BETWEEN r.observed_on AND r.valid_until
       AND p.deleted_at IS NULL AND NOT p.partner_generic AND s.vehicle_type='car' AND r.product_spec=${specSnapshot}`,
    [environment,productId]);
  return rows[0] ?? null;
}

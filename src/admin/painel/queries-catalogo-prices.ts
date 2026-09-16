import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { moneyCents } from '../../shared/catalog-pricing.js';

export interface CatalogPriceInput {
  productId: string; priceAmount: number; reason: string; actorLabel: string;
  environment?: 'prod' | 'test';
}

export async function getCatalogPriceHistory(
  productId: string,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<unknown[]> {
  const result = await dbPool.query(
    `SELECT pp.id,pp.price_amount,pp.currency,'matriz'::text AS price_type,
            pp.valid_from,pp.valid_until,
            ae.actor_label,ae.payload_after->>'reason' reason
       FROM commerce.matriz_product_prices pp
       LEFT JOIN LATERAL (
         SELECT actor_label,payload_after FROM audit.events
          WHERE environment=pp.environment::text AND entity_table='commerce.matriz_product_prices'
            AND entity_id=pp.id AND event_type='catalog_price_changed'
          ORDER BY created_at DESC LIMIT 1
       ) ae ON true
      WHERE pp.environment=$1 AND pp.product_id=$2
      ORDER BY pp.valid_from DESC LIMIT 20`,
    [environment, productId],
  );
  return result.rows;
}

export async function setCatalogPrice(
  input: CatalogPriceInput,
  dbPool: Pool = defaultPool,
): Promise<{ changed: boolean; price_id: string | null; price_amount: number }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const reason = input.reason.trim();
  if (!Number.isFinite(input.priceAmount) || input.priceAmount <= 0) throw new Error('catalog_price_invalid');
  if (Math.abs(input.priceAmount * 100 - moneyCents(input.priceAmount)) >= 1e-7) {
    throw new Error('catalog_price_cent_precision');
  }
  if (reason.length < 2) throw new Error('catalog_price_reason_required');
  const normalizedPrice = moneyCents(input.priceAmount) / 100;
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    await lockCatalogProduct(client, environment, input.productId);
    const current = await client.query<{ id: string; price_amount: string; price_type: string }>(
      `SELECT id,price_amount,'matriz'::text price_type FROM commerce.matriz_product_prices
        WHERE environment=$1 AND product_id=$2 AND valid_from<=now()
          AND (valid_until IS NULL OR valid_until>now())
        ORDER BY price_amount,id FOR UPDATE`,
      [environment, input.productId],
    );
    const official = current.rows[0] ? Number(current.rows[0].price_amount) : null;
    if (official !== null && moneyCents(official) === moneyCents(normalizedPrice)) {
      await client.query('COMMIT');
      return { changed: false, price_id: current.rows[0]!.id, price_amount: official };
    }
    await client.query(
      `UPDATE commerce.matriz_product_prices SET valid_until=now()
        WHERE environment=$1 AND product_id=$2 AND valid_from<=now()
          AND (valid_until IS NULL OR valid_until>now())`,
      [environment, input.productId],
    );
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO commerce.matriz_product_prices
         (environment,product_id,price_amount,currency,valid_from)
       VALUES ($1,$2,$3,'BRL',now()) RETURNING id`,
      [environment, input.productId, normalizedPrice],
    );
    const priceId = inserted.rows[0]!.id;
    await client.query(
      `INSERT INTO audit.events
         (environment,domain,entity_table,entity_id,event_type,actor_label,payload_before,payload_after)
       VALUES ($1,'catalog','commerce.matriz_product_prices',$2,'catalog_price_changed',$3,$4::jsonb,$5::jsonb)`,
      [environment, priceId, input.actorLabel, JSON.stringify({ active_prices: current.rows }),
       JSON.stringify({ product_id: input.productId, price_amount: normalizedPrice, reason })],
    );
    await client.query('COMMIT');
    return { changed: true, price_id: priceId, price_amount: normalizedPrice };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function lockCatalogProduct(
  client: PoolClient,
  environment: 'prod' | 'test',
  productId: string,
): Promise<void> {
  const product = await client.query(
    `SELECT id FROM commerce.products
      WHERE environment=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`,
    [environment, productId],
  );
  if (!product.rows[0]) throw new Error('catalog_product_not_found');
}

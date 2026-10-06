import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { moneyCents } from '../../shared/catalog-pricing.js';
import { getCatalogOverview } from './queries-catalogo.js';
import type { TireVehicleFilter } from '../../shared/tire-vehicle-type.js';

// Só o endpoint da Matriz recebe este campo. Consultas operacionais/bot ficam intactas.
export async function getMatrixCatalogWithWholesale(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
  vehicleType: TireVehicleFilter = 'all',
) {
  const [catalog, wholesale] = await Promise.all([
    getCatalogOverview(environment, dbPool, vehicleType),
    dbPool.query<{ product_id: string; price_amount: string }>(
      `SELECT product_id,price_amount FROM commerce.wholesale_current_prices WHERE environment=$1`,
      [environment],
    ),
  ]);
  const prices = new Map(wholesale.rows.map(row => [row.product_id, Number(row.price_amount)]));
  return { ...catalog, rows: catalog.rows.map(value => {
    const row = value as { product_id?: string; product_type?: string };
    return { ...row, wholesale_price_amount: row.product_type === 'tire' && row.product_id
      ? prices.get(row.product_id) ?? null : null };
  }) };
}

export async function getCatalogWholesaleHistory(
  productId: string,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
) {
  // Inclui retiradas da oferta (valor nulo), preservando motivo e responsável.
  const result = await dbPool.query(
    `SELECT id,created_at AS valid_from,actor_label,payload_after->>'reason' AS reason,
            (payload_after->>'price_amount')::numeric AS price_amount
       FROM audit.events
      WHERE environment=$1 AND entity_table='commerce.wholesale_product_prices'
        AND event_type='catalog_wholesale_price_changed' AND payload_after->>'product_id'=$2
      ORDER BY created_at DESC,id DESC LIMIT 20`,
    [environment, productId],
  );
  return result.rows;
}

export async function setCatalogWholesalePrice(input: {
  productId: string; priceAmount: number | null; reason: string; actorLabel: string;
  environment?: 'prod' | 'test';
}, dbPool: Pool = defaultPool) {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const reason = input.reason.trim();
  if (input.priceAmount !== null && (!Number.isFinite(input.priceAmount)
    || input.priceAmount <= 0 || input.priceAmount > 9_999_999.99
    || Math.abs(input.priceAmount * 100 - moneyCents(input.priceAmount)) >= 1e-7)) {
    throw new Error('catalog_wholesale_price_invalid');
  }
  if (reason.length < 2 || reason.length > 500) throw new Error('catalog_wholesale_reason_required');
  const price = input.priceAmount === null ? null : moneyCents(input.priceAmount) / 100;
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const product = await client.query<{ product_type: string }>(
      `SELECT product_type FROM commerce.products WHERE environment=$1 AND id=$2
        AND deleted_at IS NULL FOR UPDATE`, [environment, input.productId],
    );
    if (!product.rows[0]) throw new Error('catalog_product_not_found');
    if (product.rows[0].product_type !== 'tire') throw new Error('catalog_wholesale_product_invalid');
    const current = await client.query<{ id: string; price_amount: string }>(
      `SELECT id,price_amount FROM commerce.wholesale_product_prices
        WHERE environment=$1 AND product_id=$2 AND valid_until IS NULL FOR UPDATE`,
      [environment, input.productId],
    );
    const previous = current.rows[0];
    if ((previous ? Number(previous.price_amount) : null) === price) {
      await client.query('COMMIT');
      return { changed: false, price_id: previous?.id ?? null, price_amount: price };
    }
    // Timestamp depois do lock: transações concorrentes não reabrem janelas no passado.
    const timestamp = await client.query<{ at: string }>(
      `SELECT GREATEST(clock_timestamp(),COALESCE(max(valid_from)+interval '1 microsecond',
              '-infinity'::timestamptz))::text AS at
         FROM commerce.wholesale_product_prices WHERE environment=$1 AND product_id=$2`,
      [environment, input.productId],
    );
    const at = timestamp.rows[0]!.at;
    await client.query(`UPDATE commerce.wholesale_product_prices SET valid_until=$3
      WHERE environment=$1 AND product_id=$2 AND valid_until IS NULL`, [environment, input.productId, at]);
    let priceId: string | null = null;
    if (price !== null) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO commerce.wholesale_product_prices (environment,product_id,price_amount,valid_from)
         VALUES ($1,$2,$3,$4) RETURNING id`, [environment, input.productId, price, at],
      );
      priceId = inserted.rows[0]!.id;
    }
    await client.query(
      `INSERT INTO audit.events
         (environment,domain,entity_table,entity_id,event_type,actor_label,payload_before,payload_after)
       VALUES ($1,'catalog','commerce.wholesale_product_prices',$2,
               'catalog_wholesale_price_changed',$3,$4::jsonb,$5::jsonb)`,
      [environment, priceId ?? previous!.id, input.actorLabel,
        JSON.stringify({ product_id: input.productId, price_amount: previous ? Number(previous.price_amount) : null }),
        JSON.stringify({ product_id: input.productId, price_id: priceId, price_amount: price, reason })],
    );
    await client.query('COMMIT');
    return { changed: true, price_id: priceId, price_amount: price };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

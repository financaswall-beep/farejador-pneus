import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { moneyCents } from '../../shared/catalog-pricing.js';
import { buildMatrizStockIndex, matrizStockForMeasure } from '../../shared/matriz-stock-source.js';
import { tireSizeKey } from '../../shared/tire-size.js';

interface CatalogRow {
  product_id: string; product_code: string; product_name: string; product_type: string;
  brand: string | null; tire_size: string | null; tire_position: string | null;
  price_amount: string | null; currency: string | null; price_type: string | null;
}
interface StockRow {
  measure: string; quantity_on_hand: number | string; unit_cost: number | string | null;
  updated_at: string | null;
}
interface PurchaseRow {
  measure: string; unit_cost: number | string; purchased_at: string;
}
export interface CatalogPriceInput {
  productId: string; priceAmount: number; reason: string; actorLabel: string;
  environment?: 'prod' | 'test';
}

export async function getCatalogOverview(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<{ summary: Record<string, number>; brands: string[]; rows: unknown[] }> {
  const [catalog, stock, purchases] = await Promise.all([
    dbPool.query<CatalogRow>(
      `SELECT p.id product_id,p.product_code,p.product_name,p.product_type,p.brand,
              ts.tire_size,ts.position tire_position,
              cp.price_amount,cp.currency,cp.price_type
         FROM commerce.products p
         LEFT JOIN commerce.tire_specs ts
           ON ts.product_id=p.id AND ts.environment=p.environment
         LEFT JOIN commerce.matriz_current_prices cp
           ON cp.product_id=p.id AND cp.environment=p.environment
        WHERE p.environment=$1 AND p.deleted_at IS NULL
        ORDER BY p.brand NULLS LAST,p.product_name`,
      [environment],
    ),
    dbPool.query<StockRow>(
      `SELECT measure,quantity_on_hand,unit_cost,updated_at
         FROM commerce.wholesale_stock WHERE environment=$1`,
      [environment],
    ),
    dbPool.query<PurchaseRow>(
      `SELECT i.measure,i.unit_cost,p.purchased_at
         FROM commerce.wholesale_purchase_items i
         JOIN commerce.wholesale_purchases p
           ON p.id=i.purchase_id AND p.environment=i.environment
        WHERE i.environment=$1 AND p.status='confirmed'
        ORDER BY p.purchased_at DESC,i.created_at DESC`,
      [environment],
    ),
  ]);
  const stockIndex = buildMatrizStockIndex(stock.rows);
  const stockByKey = new Map(stock.rows.map((row) => [tireSizeKey(row.measure), row]));
  const lastPurchase = new Map<string, PurchaseRow>();
  for (const row of purchases.rows) {
    const key = tireSizeKey(row.measure);
    if (key && !lastPurchase.has(key)) lastPurchase.set(key, row);
  }
  const rows = catalog.rows.map((product) => {
    const state = matrizStockForMeasure(stockIndex, product.tire_size);
    const key = tireSizeKey(product.tire_size);
    const officialStock = key ? stockByKey.get(key) : undefined;
    const purchase = key ? lastPurchase.get(key) : undefined;
    const cost = state.unit_cost;
    const price = product.price_amount === null ? null : Number(product.price_amount);
    return {
      ...product,
      price_amount: price,
      official_quantity_on_hand: state.quantity_on_hand,
      official_unit_cost: cost,
      stock_source: 'commerce.wholesale_stock',
      stock_updated_at: officialStock?.updated_at ?? null,
      last_purchase_cost: purchase ? Number(purchase.unit_cost) : null,
      last_purchase_at: purchase?.purchased_at ?? null,
      gross_profit: price !== null && cost !== null ? (moneyCents(price) - moneyCents(cost)) / 100 : null,
      margin_percent: price && cost !== null ? ((price - cost) / price) * 100 : null,
      sellable: state.sellable && price !== null,
      block_reason: price === null ? 'catalog_price_missing' : state.block_reason,
    };
  });
  const brands = [...new Set(rows.map((row) => row.brand).filter((brand): brand is string => Boolean(brand)))];
  return {
    summary: {
      products: rows.length,
      brands: brands.length,
      without_price: rows.filter((row) => row.price_amount === null).length,
      with_stock: rows.filter((row) => row.official_quantity_on_hand > 0).length,
    },
    brands,
    rows,
  };
}

export async function getCatalogPriceHistory(
  productId: string,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<unknown[]> {
  const result = await dbPool.query(
    `SELECT pp.id,pp.price_amount,pp.currency,pp.price_type,pp.valid_from,pp.valid_until,
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
  if (reason.length < 2) throw new Error('catalog_price_reason_required');
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
    if (official !== null && Math.round(official * 100) === Math.round(input.priceAmount * 100)) {
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
      [environment, input.productId, input.priceAmount],
    );
    const priceId = inserted.rows[0]!.id;
    await client.query(
      `INSERT INTO audit.events
         (environment,domain,entity_table,entity_id,event_type,actor_label,payload_before,payload_after)
       VALUES ($1,'catalog','commerce.matriz_product_prices',$2,'catalog_price_changed',$3,$4::jsonb,$5::jsonb)`,
      [environment, priceId, input.actorLabel, JSON.stringify({ active_prices: current.rows }),
       JSON.stringify({ product_id: input.productId, price_amount: input.priceAmount, reason })],
    );
    await client.query('COMMIT');
    return { changed: true, price_id: priceId, price_amount: input.priceAmount };
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

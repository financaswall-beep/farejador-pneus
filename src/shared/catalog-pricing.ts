import type { PoolClient } from 'pg';

export interface CatalogPricedItem {
  product_id: string;
  unit_price: number;
}

export interface CurrentCatalogPrice {
  product_id: string;
  price_amount: number;
  price_type: string;
  currency: string;
}

export async function loadCurrentCatalogPrices(
  client: Pick<PoolClient, 'query'>,
  environment: 'prod' | 'test',
  productIds: string[],
): Promise<Map<string, CurrentCatalogPrice>> {
  const ids = [...new Set(productIds)];
  if (ids.length === 0) return new Map();
  const result = await client.query<{
    product_id: string;
    price_amount: number | string;
    price_type: string;
    currency: string;
  }>(
    `WITH locked_products AS MATERIALIZED (
       SELECT id FROM commerce.products
        WHERE environment=$1 AND id=ANY($2::uuid[])
        ORDER BY id FOR KEY SHARE
     )
     SELECT cp.product_id,cp.price_amount,cp.price_type,cp.currency
       FROM commerce.matriz_current_prices cp
       JOIN locked_products p ON p.id=cp.product_id
      WHERE cp.environment=$1`,
    [environment, ids],
  );
  return new Map(result.rows.map((row) => [row.product_id, {
    product_id: row.product_id,
    price_amount: Number(row.price_amount),
    price_type: row.price_type,
    currency: row.currency,
  }]));
}

/**
 * Preço vigente do fluxo da Rede/parceiros.
 *
 * Esta leitura fica deliberadamente separada do Catálogo da Matriz. O Catálogo
 * novo não pode mudar a tabela comercial que os parceiros já usam.
 */
export async function loadCurrentPartnerPrices(
  client: Pick<PoolClient, 'query'>,
  environment: 'prod' | 'test',
  productIds: string[],
): Promise<Map<string, CurrentCatalogPrice>> {
  const ids = [...new Set(productIds)];
  if (ids.length === 0) return new Map();
  const result = await client.query<{
    product_id: string;
    price_amount: number | string;
    price_type: string;
    currency: string;
  }>(
    `SELECT DISTINCT ON (product_id)
            product_id,price_amount,price_type,currency
       FROM commerce.product_prices
      WHERE environment=$1 AND product_id=ANY($2::uuid[])
        AND price_type='regular'
        AND valid_from<=now()
        AND (valid_until IS NULL OR valid_until>now())
      ORDER BY product_id,valid_from DESC,id DESC`,
    [environment, ids],
  );
  return new Map(result.rows.map((row) => [row.product_id, {
    product_id: row.product_id,
    price_amount: Number(row.price_amount),
    price_type: row.price_type,
    currency: row.currency,
  }]));
}

export async function assertCurrentCatalogPrices(
  client: Pick<PoolClient, 'query'>,
  environment: 'prod' | 'test',
  items: CatalogPricedItem[],
): Promise<void> {
  const prices = await loadCurrentCatalogPrices(client, environment, items.map((item) => item.product_id));
  for (const item of items) {
    const official = prices.get(item.product_id);
    if (!official) throw new Error('catalog_price_missing');
    if (moneyCents(official.price_amount) !== moneyCents(item.unit_price)) {
      throw new Error('catalog_price_changed');
    }
  }
}

export function moneyCents(value: number): number {
  return Math.round((Number(value) + Number.EPSILON) * 100);
}

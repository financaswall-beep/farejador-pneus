import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { loadCurrentCatalogPrices } from '../../shared/catalog-pricing.js';
import { buildMatrizStockIndex, matrizStockForMeasure } from '../../shared/matriz-stock-source.js';
import type { TireCondition } from '../../shared/tire-condition.js';
import { registerWalkinOrder } from '../painel/walkin-order.js';
import type { CaixaAuth } from './queries.js';

export type CaixaCatalogType = 'all' | 'tire' | 'service';
export type CaixaPaymentMethod = 'pix' | 'cartao' | 'dinheiro';

export interface CaixaCatalogProduct {
  product_id: string;
  product_code: string;
  product_name: string;
  product_type: 'tire' | 'service';
  brand: string | null;
  tire_condition: TireCondition | null;
  tire_size: string | null;
  price_amount: number | null;
  currency: string;
  stock_quantity: number | null;
  image_url: string | null;
  sellable: boolean;
  block_reason: string | null;
}

export interface CreateCaixaSaleInput {
  customer_name?: string | null;
  customer_phone?: string | null;
  payment_method: CaixaPaymentMethod;
  idempotency_key: string;
  items: Array<{
    product_id: string;
    quantity: number;
    unit_price: number;
    reference_unit_price?: number;
  }>;
}

interface CatalogRow {
  product_id: string;
  product_code: string;
  product_name: string;
  product_type: 'tire' | 'service';
  brand: string | null;
  tire_condition: TireCondition | null;
  tire_size: string | null;
  price_amount: string | null;
  currency: string | null;
  image_url: string | null;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

/**
 * Catálogo operacional do PDV. O saldo exibido vem do mesmo galpão usado pela
 * baixa atômica; preço vem exclusivamente do catálogo vigente da Matriz.
 */
export async function getCaixaCatalog(
  environment: 'prod' | 'test',
  search = '',
  type: CaixaCatalogType = 'all',
  dbPool: Pool = defaultPool,
): Promise<{ products: CaixaCatalogProduct[] }> {
  const normalizedSearch = search.trim().slice(0, 80);
  const searchPattern = normalizedSearch ? `%${escapeLike(normalizedSearch)}%` : null;
  const catalog = await dbPool.query<CatalogRow>(
    `SELECT p.id AS product_id,p.product_code,p.product_name,p.product_type,
            p.brand,p.tire_condition,ts.tire_size,cp.price_amount::text,
            cp.currency,media.media_url AS image_url
       FROM commerce.products p
       LEFT JOIN commerce.tire_specs ts
         ON ts.product_id=p.id AND ts.environment=p.environment
       LEFT JOIN commerce.matriz_current_prices cp
         ON cp.product_id=p.id AND cp.environment=p.environment
       LEFT JOIN LATERAL (
         SELECT pm.media_url
           FROM commerce.product_media pm
          WHERE pm.environment=p.environment AND pm.product_id=p.id
            AND pm.media_type='image'
            AND (pm.media_url ~* '^https?://' OR pm.media_url LIKE '/%')
          ORDER BY pm.display_order,pm.created_at,pm.id
          LIMIT 1
       ) media ON true
      WHERE p.environment=$1 AND p.deleted_at IS NULL
        AND p.product_type IN ('tire','service')
        AND ($2::text IS NULL OR concat_ws(' ',p.product_code,p.product_name,p.brand,ts.tire_size)
              ILIKE $2 ESCAPE '\\')
        AND ($3::text='all' OR p.product_type=$3)
      ORDER BY p.product_name,p.product_code
      LIMIT 100`,
    [environment, searchPattern, type],
  );

  const stock = await dbPool.query<{
    measure: string; brand: string; tire_condition: TireCondition;
    quantity_on_hand: number | string; quantity_reserved: number | string;
    unit_cost: number | string | null;
  }>(
    `SELECT measure,brand,tire_condition,quantity_on_hand,quantity_reserved,unit_cost
       FROM commerce.wholesale_stock
      WHERE environment=$1`,
    [environment],
  );
  const stockIndex = buildMatrizStockIndex(stock.rows);

  const products = catalog.rows.map<CaixaCatalogProduct>((row) => {
    const price = row.price_amount === null ? null : Number(row.price_amount);
    const usablePrice = price !== null && Number.isFinite(price) && price > 0;
    if (row.product_type === 'service') {
      return {
        ...row,
        price_amount: price,
        currency: row.currency ?? 'BRL',
        stock_quantity: null,
        sellable: usablePrice,
        block_reason: usablePrice ? null : 'catalog_price_missing',
      };
    }
    const official = matrizStockForMeasure(
      stockIndex,
      row.tire_size,
      row.brand,
      row.tire_condition,
    );
    return {
      ...row,
      price_amount: price,
      currency: row.currency ?? 'BRL',
      stock_quantity: official.quantity_available,
      sellable: official.sellable && usablePrice,
      block_reason: usablePrice ? official.block_reason : 'catalog_price_missing',
    };
  }).sort((a, b) => {
    if (a.sellable !== b.sellable) return a.sellable ? -1 : 1;
    const stockA = a.stock_quantity ?? Number.MAX_SAFE_INTEGER;
    const stockB = b.stock_quantity ?? Number.MAX_SAFE_INTEGER;
    return stockB - stockA || a.product_name.localeCompare(b.product_name, 'pt-BR');
  });

  return { products };
}

/**
 * Porta de escrita do PDV. O navegador envia o preço negociado, mas o servidor
 * resolve e trava o preço oficial, vendedor, unidade, origem e rótulo financeiro.
 */
export async function createCaixaSale(
  environment: 'prod' | 'test',
  auth: CaixaAuth,
  input: CreateCaixaSaleInput,
  dbPool: Pool = defaultPool,
): Promise<{ order_id: string }> {
  // O PDV nunca pode baixar estoque sem aparecer no Financeiro central.
  if (!env.MATRIZ_CENTRAL_LEDGER || !env.MATRIZ_CENTRAL_LEDGER_READ) {
    throw new Error('caixa_finance_not_ready');
  }

  const requested = new Map<string, { quantity: number; unitPrice: number; referencePrice?: number }>();
  for (const item of input.items) {
    if (requested.has(item.product_id)) throw new Error('walkin_item_duplicate');
    requested.set(item.product_id, {
      quantity: item.quantity,
      unitPrice: item.unit_price,
      referencePrice: item.reference_unit_price,
    });
  }
  const productIds = [...requested.keys()];
  const products = await dbPool.query<{ id: string; product_type: string }>(
    `SELECT id,product_type
       FROM commerce.products
      WHERE environment=$1 AND deleted_at IS NULL AND id=ANY($2::uuid[])
        AND product_type IN ('tire','service')`,
    [environment, productIds],
  );
  if (products.rows.length !== productIds.length) {
    throw new Error('walkin_product_not_sellable');
  }

  const prices = await loadCurrentCatalogPrices(dbPool, environment, productIds);
  const items = productIds.map((productId) => {
    const price = prices.get(productId);
    if (!price) throw new Error('catalog_price_missing');
    const line = requested.get(productId)!;
    if (line.referencePrice !== undefined
      && Math.round(line.referencePrice * 100) !== Math.round(price.price_amount * 100)) {
      throw new Error('catalog_price_changed');
    }
    return {
      product_id: productId,
      quantity: line.quantity,
      unit_price: line.unitPrice,
      reference_unit_price: price.price_amount,
      discount_amount: 0,
    };
  });

  const customerName = input.customer_name?.trim() || 'Cliente Balcão';
  const customerPhone = input.customer_phone?.trim() || null;
  return registerWalkinOrder({
    environment,
    customer_name: customerName,
    customer_phone: customerPhone,
    unit_id: null,
    items,
    payment_method: input.payment_method,
    payment_due_on: null,
    fulfillment_mode: 'pickup',
    delivery_address: null,
    actor_label: `Caixa: ${auth.displayName} (${auth.username})`.slice(0, 120),
    seller_collaborator_id: auth.collaboratorId,
    idempotency_key: input.idempotency_key,
    source_tag: 'walkin_balcao',
  }, dbPool);
}

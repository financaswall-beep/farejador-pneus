import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import type { SafeStockRow } from '../../parceiro/operation-stock.js';
import { setCatalogPrice } from '../painel/queries-catalogo.js';
import { tireSizeKey } from '../../shared/tire-size.js';

type MatrizStockRow = SafeStockRow & {
  product_id: string | null;
  sale_price: number | null;
};

function brandKey(value: string | null | undefined): string {
  return (value ?? '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function variantKey(measure: string, brand: string, condition: string): string {
  return `${tireSizeKey(measure)}\u0000${brandKey(brand)}\u0000${condition}`;
}

/**
 * Consulta operacional do galpao para a porta unificada.
 *
 * A resposta imita o contrato visual do parceiro e nao devolve custo. A unica
 * mutacao associada e a tabela comercial do catalogo; saldo e custo continuam
 * exclusivamente em commerce.wholesale_stock.
 */
export async function getMatrizOperationStock(
  db: Pool = defaultPool,
): Promise<{
  rows: MatrizStockRow[];
  pending: { item_registrations: 0; stock_counts: 0 };
  readonly: true;
  stock_readonly: true;
}> {
  const [result, catalog] = await Promise.all([db.query<{
    id: string;
    measure: string;
    brand: string;
    tire_condition: 'meia_vida' | 'novo' | 'remold';
    quantity_on_hand: number;
    quantity_reserved: number;
    quantity_available: number;
    min_quantity: number | null;
    updated_at: string;
    tire_width_mm: number | null;
    tire_aspect_ratio: number | null;
    tire_rim_diameter: number | null;
  }>(
    `SELECT id,measure,brand,tire_condition,quantity_on_hand,quantity_reserved,
            GREATEST(quantity_on_hand-quantity_reserved,0)::int quantity_available,
            min_quantity,updated_at,tire_width_mm,tire_aspect_ratio,tire_rim_diameter
       FROM commerce.wholesale_stock
      WHERE environment=$1
      ORDER BY measure,brand,tire_condition`,
    [env.FAREJADOR_ENV],
  ), db.query<{
    product_id: string;
    tire_size: string;
    brand: string;
    tire_condition: string;
    sale_price: string | null;
  }>(
    `SELECT p.id product_id,ts.tire_size,p.brand,p.tire_condition,
            cp.price_amount::text sale_price
       FROM commerce.products p
       JOIN commerce.tire_specs ts
         ON ts.product_id=p.id AND ts.environment=p.environment
       LEFT JOIN commerce.matriz_current_prices cp
         ON cp.product_id=p.id AND cp.environment=p.environment
      WHERE p.environment=$1 AND p.deleted_at IS NULL AND p.product_type='tire'`,
    [env.FAREJADOR_ENV],
  )]);
  const productsByVariant = new Map<string, typeof catalog.rows>();
  for (const product of catalog.rows) {
    const key = variantKey(product.tire_size, product.brand, product.tire_condition);
    productsByVariant.set(key, [...(productsByVariant.get(key) ?? []), product]);
  }
  const rows: MatrizStockRow[] = result.rows.map((row) => ({
    ...(function () {
      const matches = productsByVariant.get(variantKey(row.measure, row.brand, row.tire_condition)) ?? [];
      const product = matches.length === 1 ? matches[0]! : null;
      return {
        product_id: product?.product_id ?? null,
        sale_price: product?.sale_price == null ? null : Number(product.sale_price),
      };
    }()),
    stock_id: row.id,
    local_sku: null,
    item_name: row.measure,
    item_type: 'pneu',
    tire_size: row.measure,
    tire_width_mm: row.tire_width_mm,
    tire_aspect_ratio: row.tire_aspect_ratio,
    tire_rim_diameter: row.tire_rim_diameter,
    brand: row.brand,
    quantity_on_hand: Number(row.quantity_on_hand),
    quantity_reserved: Number(row.quantity_reserved),
    quantity_available: Number(row.quantity_available),
    minimum_quantity: row.min_quantity == null ? null : Number(row.min_quantity),
    stock_status: Number(row.quantity_on_hand) <= 0
      ? 'out_of_stock'
      : (Number(row.quantity_available) <= 0
        ? 'reserved'
      : (row.min_quantity != null && Number(row.quantity_available) <= Number(row.min_quantity)
        ? 'low_stock' : 'in_stock')),
    tire_condition: row.tire_condition,
    shelf_location: null,
    tire_position: null,
    is_tracked: true,
    updated_at: row.updated_at,
  }));
  return {
    rows,
    pending: { item_registrations: 0, stock_counts: 0 },
    readonly: true,
    stock_readonly: true,
  };
}

export class MatrizOperationStockPriceError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
  }
}

export async function setMatrizOperationStockPrice(
  stockId: string,
  salePrice: number,
  reason: string,
  actorLabel: string,
  db: Pool = defaultPool,
): Promise<{ changed: boolean; stock_id: string; sale_price: number }> {
  const stock = await getMatrizOperationStock(db);
  const row = stock.rows.find((item) => item.stock_id === stockId);
  if (!row) throw new MatrizOperationStockPriceError('stock_not_found', 404);
  if (!row.product_id) throw new MatrizOperationStockPriceError('catalog_product_not_found', 409);
  try {
    const result = await setCatalogPrice({
      productId: row.product_id,
      priceAmount: salePrice,
      reason,
      actorLabel,
      environment: env.FAREJADOR_ENV,
    }, db);
    return {
      changed: result.changed,
      stock_id: stockId,
      sale_price: result.price_amount,
    };
  } catch (error) {
    if (error instanceof Error && [
      'catalog_price_invalid', 'catalog_price_reason_required',
    ].includes(error.message)) {
      throw new MatrizOperationStockPriceError(error.message, 400);
    }
    if (error instanceof Error && error.message === 'catalog_product_not_found') {
      throw new MatrizOperationStockPriceError(error.message, 404);
    }
    throw error;
  }
}

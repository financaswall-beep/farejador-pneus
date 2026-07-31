import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { tireSizeKey } from '../../shared/tire-size.js';
import { canonicalCatalogBrand } from './catalog-brand.js';

export interface CreateCatalogProductInput {
  measure: string;
  brand: string;
  productCode: string;
  productName: string;
  actorLabel: string;
  environment?: 'prod' | 'test';
}

export interface CreatedCatalogProduct {
  product_id: string;
  product_code: string;
  product_name: string;
  brand: string;
  tire_size: string;
}

interface StockVariant {
  measure: string;
  brand: string;
  tire_width_mm: number | null;
  tire_aspect_ratio: number | null;
  tire_rim_diameter: number | null;
}

function normalizeCode(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function brandKey(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export async function createCatalogProductFromStock(
  input: CreateCatalogProductInput,
  dbPool: Pool = defaultPool,
): Promise<CreatedCatalogProduct> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const measure = input.measure.trim();
  const brand = canonicalCatalogBrand(input.brand);
  const productCode = normalizeCode(input.productCode);
  const productName = normalizeName(input.productName);
  if (!measure) throw new Error('catalog_measure_required');
  const measureKey = tireSizeKey(measure);
  if (!measureKey) throw new Error('catalog_measure_invalid');
  if (!brand || brand.toLowerCase() === 'sem marca') throw new Error('catalog_brand_required');
  if (!/^[A-Z0-9][A-Z0-9._/-]{1,79}$/.test(productCode)) {
    throw new Error('catalog_product_code_invalid');
  }
  if (productName.length < 2 || productName.length > 160) {
    throw new Error('catalog_product_name_invalid');
  }

  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [`catalog-variant:${environment}:${measureKey}:${brandKey(brand)}`],
    );
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [`catalog-code:${environment}:${productCode.toLowerCase()}`],
    );
    const stock = await client.query<StockVariant>(
      `SELECT measure,brand,tire_width_mm,tire_aspect_ratio,tire_rim_diameter
         FROM commerce.wholesale_stock
        WHERE environment=$1 AND measure=$2 AND lower(brand)=lower($3)
        FOR UPDATE`,
      [environment, measure, brand],
    );
    const variant = stock.rows[0];
    if (!variant) throw new Error('catalog_stock_variant_not_found');
    if (stock.rows.length > 1) throw new Error('catalog_stock_variant_ambiguous');

    const existing = await client.query<{
      id: string; product_code: string; deleted_at: string | null;
    }>(
      `SELECT p.id,p.product_code,p.deleted_at
         FROM commerce.products p
         JOIN commerce.tire_specs ts
           ON ts.product_id=p.id AND ts.environment=p.environment
        WHERE p.environment=$1
          AND regexp_replace(lower(ts.tire_size),'[^a-z0-9]+','','g')=$2
          AND lower(btrim(COALESCE(p.brand,'')))=lower(btrim($3))
        ORDER BY p.deleted_at NULLS FIRST,p.id
        FOR UPDATE OF p`,
      [environment, tireSizeKey(variant.measure), variant.brand],
    );
    if (existing.rows.some((row) => row.deleted_at === null)) {
      throw new Error('catalog_variant_already_exists');
    }
    if (existing.rows.length) throw new Error('catalog_variant_archived');

    const duplicateCode = await client.query(
      `SELECT id FROM commerce.products
        WHERE environment=$1 AND lower(product_code)=lower($2)
        FOR UPDATE`,
      [environment, productCode],
    );
    if (duplicateCode.rows.length) throw new Error('catalog_product_code_duplicate');

    const product = await client.query<{ id: string }>(
      `INSERT INTO commerce.products
         (environment,product_code,product_name,product_type,brand)
       VALUES ($1,$2,$3,'tire',$4)
       RETURNING id`,
      [environment, productCode, productName, variant.brand],
    );
    const productId = product.rows[0]!.id;
    await client.query(
      `INSERT INTO commerce.tire_specs
         (environment,product_id,tire_size,width_mm,aspect_ratio,rim_diameter)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        environment, productId, variant.measure, variant.tire_width_mm,
        variant.tire_aspect_ratio, variant.tire_rim_diameter,
      ],
    );
    await client.query(
      `INSERT INTO audit.events
         (environment,domain,entity_table,entity_id,event_type,actor_label,payload_after)
       VALUES ($1,'catalog','commerce.products',$2,'catalog_product_created',$3,$4::jsonb)`,
      [
        environment, productId, input.actorLabel.trim().slice(0, 120) || 'admin',
        JSON.stringify({
          product_code: productCode,
          product_name: productName,
          brand: variant.brand,
          tire_size: variant.measure,
          source: 'wholesale_stock',
        }),
      ],
    );
    await client.query('COMMIT');
    return {
      product_id: productId,
      product_code: productCode,
      product_name: productName,
      brand: variant.brand,
      tire_size: variant.measure,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    const dbError = error as Error & { code?: string; constraint?: string };
    if (dbError.code === '23505'
      && dbError.constraint?.includes('product_code')) {
      throw new Error('catalog_product_code_duplicate');
    }
    throw error;
  } finally {
    client.release();
  }
}

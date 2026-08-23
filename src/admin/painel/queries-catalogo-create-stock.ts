import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { tireSizeKey } from '../../shared/tire-size.js';
import { canonicalCatalogBrand } from './catalog-brand.js';
import { requireTireCondition, type TireCondition } from '../../shared/tire-condition.js';
import type { CreateCatalogProductInput, CreatedCatalogProduct } from './queries-catalogo-create.js';

interface StockVariant {
  measure: string;
  brand: string;
  tire_condition: TireCondition;
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
  const tireCondition = requireTireCondition(input.tireCondition ?? 'meia_vida');
  const productCode = normalizeCode(input.productCode);
  const productName = normalizeName(input.productName);
  if (!measure) throw new Error('catalog_measure_required');
  if (!tireSizeKey(measure)) throw new Error('catalog_measure_invalid');
  const measureKey = measure.replace(/\D/g, '');
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
      [`catalog-variant:${environment}:${measureKey}:${brandKey(brand)}:${tireCondition}`],
    );
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [`catalog-code:${environment}:${productCode.toLowerCase()}`],
    );
    const stock = await client.query<StockVariant>(
      `SELECT measure,brand,tire_condition,tire_width_mm,tire_aspect_ratio,tire_rim_diameter
         FROM commerce.wholesale_stock
        WHERE environment=$1 AND measure=$2 AND lower(brand)=lower($3)
          AND tire_condition=$4
        FOR UPDATE`,
      [environment, measure, brand, tireCondition],
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
          AND regexp_replace(ts.tire_size,'[^0-9]+','','g')=$2
          AND lower(btrim(COALESCE(p.brand,'')))=lower(btrim($3))
          AND p.tire_condition=$4
        ORDER BY p.deleted_at NULLS FIRST,p.id
        FOR UPDATE OF p`,
      [environment, variant.measure.replace(/\D/g, ''), variant.brand, tireCondition],
    );
    if (existing.rows.some((row) => row.deleted_at === null)) {
      throw new Error('catalog_variant_already_exists');
    }
    const archivedProductIds = existing.rows
      .filter((row) => row.deleted_at !== null)
      .map((row) => row.id);

    const duplicateCode = await client.query(
      `SELECT id FROM commerce.products
        WHERE environment=$1 AND lower(product_code)=lower($2)
        FOR UPDATE`,
      [environment, productCode],
    );
    if (duplicateCode.rows.length) throw new Error('catalog_product_code_duplicate');

    const product = await client.query<{ id: string }>(
      `INSERT INTO commerce.products
         (environment,product_code,product_name,product_type,brand,tire_condition)
       VALUES ($1,$2,$3,'tire',$4,$5)
       RETURNING id`,
      [environment, productCode, productName, variant.brand, tireCondition],
    );
    const productId = product.rows[0]!.id;
    const tireSpec = await client.query<{ id: string }>(
      `INSERT INTO commerce.tire_specs
         (environment,product_id,tire_size,width_mm,aspect_ratio,rim_diameter)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id`,
      [
        environment, productId, variant.measure, variant.tire_width_mm,
        variant.tire_aspect_ratio, variant.tire_rim_diameter,
      ],
    );
    const tireSpecId = tireSpec.rows[0]?.id ?? (await client.query<{ id: string }>(
      `SELECT id FROM commerce.tire_specs
        WHERE environment=$1 AND product_id=$2`,
      [environment, productId],
    )).rows[0]!.id;
    const copiedFitments = await client.query(
      `INSERT INTO commerce.vehicle_fitments
         (environment,vehicle_model_id,tire_spec_id,position,is_oem,source,confidence_level)
       SELECT DISTINCT ON (vf.vehicle_model_id,vf.position)
              $1::env_t,vf.vehicle_model_id,$2,vf.position,vf.is_oem,vf.source,vf.confidence_level
         FROM commerce.vehicle_fitments vf
         JOIN commerce.tire_specs source_spec
           ON source_spec.id=vf.tire_spec_id AND source_spec.environment=vf.environment
        WHERE vf.environment=$1::env_t
          AND source_spec.id<>$2
          AND regexp_replace(source_spec.tire_size,'[^0-9]+','','g')
              =regexp_replace($3,'[^0-9]+','','g')
        ORDER BY vf.vehicle_model_id,vf.position,vf.is_oem DESC,
                 vf.confidence_level DESC NULLS LAST,vf.created_at
       ON CONFLICT (environment,vehicle_model_id,tire_spec_id,position) DO NOTHING`,
      [environment, tireSpecId, variant.measure],
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
          tire_condition: tireCondition,
          tire_size: variant.measure,
          source: 'wholesale_stock',
          inherited_fitments: copiedFitments.rowCount ?? 0,
          supersedes_archived_product_ids: archivedProductIds,
        }),
      ],
    );
    await client.query('COMMIT');
    return {
      product_id: productId,
      product_code: productCode,
      product_name: productName,
      brand: variant.brand,
      tire_condition: tireCondition,
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

import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { canonicalCatalogBrand } from './catalog-brand.js';
import { moneyCents } from '../../shared/catalog-pricing.js';
import { parseCatalogTireMeasure } from './catalog-tire-measure.js';
import {
  requireTireCondition,
  type TireCondition,
} from '../../shared/tire-condition.js';

export interface CreateCatalogProductInput {
  measure: string;
  brand: string;
  tireCondition: TireCondition | string;
  productCode: string;
  productName: string;
  actorLabel: string;
  environment?: 'prod' | 'test';
  priceAmount?: number | null;
  priceReason?: string | null;
}

export interface CreatedCatalogProduct {
  product_id: string;
  product_code: string;
  product_name: string;
  brand: string;
  tire_condition: TireCondition;
  tire_size: string;
  price_amount?: number | null;
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

function validateInitialPrice(input: CreateCatalogProductInput): {
  amount: number | null; reason: string | null;
} {
  if (input.priceAmount === undefined || input.priceAmount === null) {
    return { amount: null, reason: null };
  }
  if (!Number.isFinite(input.priceAmount) || input.priceAmount <= 0
    || Math.abs(input.priceAmount * 100 - moneyCents(input.priceAmount)) >= 1e-7) {
    throw new Error('catalog_price_invalid');
  }
  const reason = input.priceReason?.trim() || 'Preço inicial do cadastro';
  if (reason.length < 2 || reason.length > 500) throw new Error('catalog_price_reason_required');
  return { amount: moneyCents(input.priceAmount) / 100, reason };
}

/**
 * Cria o dado mestre antes da primeira compra. Não cria estoque, movimento,
 * custo, pedido ou lançamento financeiro. A disponibilidade continua fechada
 * até existir preço oficial e saldo físico recebido.
 */
export async function createCatalogProduct(
  input: CreateCatalogProductInput,
  dbPool: Pool = defaultPool,
): Promise<CreatedCatalogProduct> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const parsedMeasure = parseCatalogTireMeasure(input.measure);
  if (!parsedMeasure) throw new Error('catalog_measure_invalid');
  const brand = canonicalCatalogBrand(input.brand);
  const tireCondition = requireTireCondition(input.tireCondition ?? 'meia_vida');
  const productCode = normalizeCode(input.productCode);
  const initialPrice = validateInitialPrice(input);
  if (!brand || brand.toLowerCase() === 'sem marca') throw new Error('catalog_brand_required');
  const productName = normalizeName(`Pneu ${brand} ${parsedMeasure.canonical}`);
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
      [`catalog-variant:${environment}:${parsedMeasure.key}:${brandKey(brand)}:${tireCondition}`],
    );
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [`catalog-code:${environment}:${productCode.toLowerCase()}`],
    );
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
      [environment, parsedMeasure.canonical.replace(/\D/g, ''), brand, tireCondition],
    );
    if (existing.rows.some((row) => row.deleted_at === null)) {
      throw new Error('catalog_variant_already_exists');
    }
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
      [environment, productCode, productName, brand, tireCondition],
    );
    const productId = product.rows[0]!.id;
    const tireSpec = await client.query<{ id: string }>(
      `INSERT INTO commerce.tire_specs
         (environment,product_id,tire_size,width_mm,aspect_ratio,rim_diameter)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id`,
      [environment, productId, parsedMeasure.canonical, parsedMeasure.widthMm,
       parsedMeasure.aspectRatio, parsedMeasure.rimDiameter],
    );
    const tireSpecId = tireSpec.rows[0]!.id;
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
          AND regexp_replace(source_spec.tire_size,'[^0-9]+','','g')=$3
        ORDER BY vf.vehicle_model_id,vf.position,vf.is_oem DESC,
                 vf.confidence_level DESC NULLS LAST,vf.created_at
       ON CONFLICT (environment,vehicle_model_id,tire_spec_id,position) DO NOTHING`,
      [environment, tireSpecId, parsedMeasure.canonical.replace(/\D/g, '')],
    );

    let priceId: string | null = null;
    if (initialPrice.amount !== null) {
      const price = await client.query<{ id: string }>(
        `INSERT INTO commerce.matriz_product_prices
           (environment,product_id,price_amount,currency,valid_from)
         VALUES ($1,$2,$3,'BRL',now()) RETURNING id`,
        [environment, productId, initialPrice.amount],
      );
      priceId = price.rows[0]!.id;
      await client.query(
        `INSERT INTO audit.events
           (environment,domain,entity_table,entity_id,event_type,actor_label,payload_before,payload_after)
         VALUES ($1,'catalog','commerce.matriz_product_prices',$2,'catalog_price_changed',$3,$4::jsonb,$5::jsonb)`,
        [environment, priceId, input.actorLabel.trim().slice(0, 120) || 'admin',
         JSON.stringify({ active_prices: [] }),
         JSON.stringify({ product_id: productId, price_amount: initialPrice.amount,
           reason: initialPrice.reason })],
      );
    }
    await client.query(
      `INSERT INTO audit.events
         (environment,domain,entity_table,entity_id,event_type,actor_label,payload_after)
       VALUES ($1,'catalog','commerce.products',$2,'catalog_product_created',$3,$4::jsonb)`,
      [environment, productId, input.actorLabel.trim().slice(0, 120) || 'admin',
       JSON.stringify({
         product_code: productCode,
         product_name: productName,
         brand,
         tire_condition: tireCondition,
         tire_size: parsedMeasure.canonical,
         source: 'catalog_manual',
         initial_price_id: priceId,
         inherited_fitments: copiedFitments.rowCount ?? 0,
         supersedes_archived_product_ids: existing.rows
           .filter((row) => row.deleted_at !== null).map((row) => row.id),
         effects: { stock: false, purchase: false, finance: false, orders: false },
       })],
    );
    await client.query('COMMIT');
    return {
      product_id: productId,
      product_code: productCode,
      product_name: productName,
      brand,
      tire_condition: tireCondition,
      tire_size: parsedMeasure.canonical,
      price_amount: initialPrice.amount,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    const dbError = error as Error & { code?: string; constraint?: string };
    if (dbError.code === '23505' && dbError.constraint?.includes('product_code')) {
      throw new Error('catalog_product_code_duplicate');
    }
    throw error;
  } finally {
    client.release();
  }
}

export { createCatalogProductFromStock } from './queries-catalogo-create-stock.js';

import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { tireSizeKey } from '../../shared/tire-size.js';
import {
  requireTireCondition,
  type TireCondition,
} from '../../shared/tire-condition.js';
import { canonicalCatalogBrand } from './catalog-brand.js';
import { setGalpaoMovContext } from './queries-galpao-movimentos.js';
import {
  beginIntegrityOperation,
  completeIntegrityOperation,
  integrityResult,
  operationFingerprint,
  recordIntegrityEvent,
} from './stage5-integrity.js';

interface StockVariant {
  id: string;
  measure: string;
  brand: string;
  tire_condition: TireCondition;
  quantity_on_hand: number;
  unit_cost: string;
  min_quantity: number | null;
  notes: string | null;
  tire_width_mm: number | null;
  tire_aspect_ratio: number | null;
  tire_rim_diameter: number | null;
  created_at: string;
}

interface CatalogProduct {
  id: string;
  product_code: string;
  product_name: string;
  brand: string | null;
}

export interface CorrectWholesaleStockBrandResult {
  stock_id: string;
  measure: string;
  from_brand: string;
  to_brand: string;
  tire_condition: TireCondition;
  quantity_on_hand: number;
  unit_cost: number;
  catalog_product_id: string | null;
  catalog_product_updated: boolean;
}

function brandKey(value: string | null | undefined): string {
  return (value ?? '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Corrige a marca da variante inteira sem reescrever compras, vendas ou movimentos
 * antigos. A identidade do estoque e imutavel por trigger; por isso a troca e feita
 * como DELETE + INSERT atomicos, reutilizando o mesmo id e preservando todos os valores.
 */
export async function correctWholesaleStockBrand(
  input: {
    measure: string;
    from_brand: string;
    to_brand: string;
    tire_condition: TireCondition | string;
    reason: string;
    idempotency_key: string;
    actor_label?: string | null;
    environment?: 'prod' | 'test';
  },
  dbPool: Pool = defaultPool,
): Promise<CorrectWholesaleStockBrandResult> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const measure = input.measure.trim();
  const fromBrand = canonicalCatalogBrand(input.from_brand) ?? 'Sem marca';
  const toBrand = canonicalCatalogBrand(input.to_brand);
  const tireCondition = requireTireCondition(input.tire_condition);
  const reason = input.reason.trim();
  if (!measure || !tireSizeKey(measure)) throw new Error('brand_correction_measure_invalid');
  if (!toBrand || brandKey(toBrand) === 'semmarca') {
    throw new Error('brand_correction_target_required');
  }
  if (brandKey(fromBrand) === brandKey(toBrand)) throw new Error('brand_correction_same');
  if (reason.length < 2) throw new Error('reason_required');

  const operation = {
    environment,
    domain: 'stock.brand_correction',
    idempotencyKey: input.idempotency_key,
    fingerprint: operationFingerprint({
      measure, from_brand: fromBrand, to_brand: toBrand,
      tire_condition: tireCondition, reason,
    }),
  };
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const started = await beginIntegrityOperation<CorrectWholesaleStockBrandResult>(
      client, operation,
    );
    if (started.replayed) {
      await client.query('COMMIT');
      return started.result;
    }

    // Serializa correcoes da mesma medida/condicao. Escritas comuns continuam
    // protegidas pelo indice unico; qualquer corrida aborta a transacao inteira.
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [`stock-brand:${environment}:${tireSizeKey(measure)}:${tireCondition}`],
    );
    const lockedStock = await client.query<StockVariant>(
      `SELECT id,measure,brand,tire_condition,quantity_on_hand,unit_cost::text,
              min_quantity,notes,tire_width_mm,tire_aspect_ratio,
              tire_rim_diameter,created_at::text
         FROM commerce.wholesale_stock
        WHERE environment=$1 AND measure=$2 AND tire_condition=$3
        ORDER BY brand,id
        FOR UPDATE`,
      [environment, measure, tireCondition],
    );
    const sourceRows = lockedStock.rows.filter((row) =>
      brandKey(row.brand) === brandKey(fromBrand));
    const targetRows = lockedStock.rows.filter((row) =>
      brandKey(row.brand) === brandKey(toBrand));
    if (sourceRows.length === 0) throw new Error('brand_correction_source_not_found');
    if (sourceRows.length > 1) throw new Error('brand_correction_source_ambiguous');
    if (targetRows.length > 0) throw new Error('brand_correction_target_exists');
    const source = sourceRows[0]!;

    // O produto e uma identidade comercial separada. Quando ele ainda usa a
    // marca antiga, corrige o cabecalho e preserva id, preco, fotos e fitments.
    // Se ja existe somente o produto de destino, o estoque passa a se ligar a ele.
    const products = await client.query<CatalogProduct>(
      `SELECT p.id,p.product_code,p.product_name,p.brand
         FROM commerce.products p
         JOIN commerce.tire_specs ts
           ON ts.product_id=p.id AND ts.environment=p.environment
        WHERE p.environment=$1 AND p.deleted_at IS NULL AND p.product_type='tire'
          AND p.tire_condition=$2
          AND regexp_replace(ts.tire_size,'[^0-9]+','','g')=$3
        ORDER BY p.id
        FOR UPDATE OF p`,
      [environment, tireCondition, measure.replace(/\D/g, '')],
    );
    const sourceProducts = products.rows.filter((row) =>
      brandKey(row.brand || 'Sem marca') === brandKey(fromBrand));
    const targetProducts = products.rows.filter((row) =>
      brandKey(row.brand) === brandKey(toBrand));
    if (sourceProducts.length > 1 || targetProducts.length > 1) {
      throw new Error('brand_correction_catalog_ambiguous');
    }
    const sourceProduct = sourceProducts[0] ?? null;
    const targetProduct = targetProducts[0] ?? null;
    if (sourceProduct && targetProduct && sourceProduct.id !== targetProduct.id) {
      throw new Error('brand_correction_catalog_conflict');
    }

    let catalogProduct = targetProduct;
    let catalogProductUpdated = false;
    if (sourceProduct && !targetProduct) {
      const updated = await client.query<CatalogProduct>(
        `UPDATE commerce.products
            SET brand=$3,
                updated_at=now(),
                product_name=CASE
                  WHEN lower(regexp_replace(btrim(product_name),'[[:space:]]+',' ','g'))
                       IN ('sem marca','pneu sem marca')
                    THEN 'Pneu ' || $3
                  ELSE product_name
                END
          WHERE environment=$1 AND id=$2 AND deleted_at IS NULL
          RETURNING id,product_code,product_name,brand`,
        [environment, sourceProduct.id, toBrand],
      );
      catalogProduct = updated.rows[0] ?? null;
      catalogProductUpdated = true;
    }

    await setGalpaoMovContext(client, {
      source: 'correcao_marca',
      nature: 'brand_correction',
      reason,
      ref: operation.idempotencyKey,
    });
    const removed = await client.query(
      `DELETE FROM commerce.wholesale_stock
        WHERE environment=$1 AND id=$2
        RETURNING id`,
      [environment, source.id],
    );
    if (!removed.rows[0]) throw new Error('brand_correction_source_not_found');
    const inserted = await client.query<StockVariant>(
      `INSERT INTO commerce.wholesale_stock (
         id,environment,measure,brand,tire_condition,quantity_on_hand,unit_cost,
         min_quantity,notes,tire_width_mm,tire_aspect_ratio,tire_rim_diameter,created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id,measure,brand,tire_condition,quantity_on_hand,unit_cost::text,
                 min_quantity,notes,tire_width_mm,tire_aspect_ratio,
                 tire_rim_diameter,created_at::text`,
      [
        source.id, environment, source.measure, toBrand, source.tire_condition,
        source.quantity_on_hand, Number(source.unit_cost), source.min_quantity,
        source.notes, source.tire_width_mm, source.tire_aspect_ratio,
        source.tire_rim_diameter, source.created_at,
      ],
    );
    const target = inserted.rows[0]!;
    const result = integrityResult<CorrectWholesaleStockBrandResult>({
      stock_id: target.id,
      measure: target.measure,
      from_brand: source.brand,
      to_brand: target.brand,
      tire_condition: target.tire_condition,
      quantity_on_hand: Number(target.quantity_on_hand),
      unit_cost: Number(target.unit_cost),
      catalog_product_id: catalogProduct?.id ?? null,
      catalog_product_updated: catalogProductUpdated,
    });
    if (catalogProductUpdated && sourceProduct && catalogProduct) {
      await recordIntegrityEvent(client, {
        environment,
        domain: 'catalog',
        entityTable: 'commerce.products',
        entityId: catalogProduct.id,
        eventType: 'catalog_product_brand_corrected',
        actorLabel: input.actor_label,
        idempotencyKey: operation.idempotencyKey,
        before: sourceProduct,
        after: { ...catalogProduct, reason },
      });
    }
    await recordIntegrityEvent(client, {
      environment,
      domain: 'stock',
      entityTable: 'commerce.wholesale_stock',
      entityId: target.id,
      eventType: 'brand_corrected',
      actorLabel: input.actor_label,
      idempotencyKey: operation.idempotencyKey,
      before: { stock: source, catalog_product: sourceProduct },
      after: {
        ...result,
        reason,
        catalog_product: catalogProduct,
      },
    });
    await completeIntegrityOperation(
      client, operation, 'commerce.wholesale_stock', target.id, result,
    );
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    const dbError = error as Error & { code?: string };
    if (dbError.code === '23505') throw new Error('brand_correction_target_exists');
    throw error;
  } finally {
    client.release();
  }
}

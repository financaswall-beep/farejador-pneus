import type { Pool, PoolClient } from 'pg';

const KNOWN_BRANDS = new Map<string, string>([
  ['pirelli', 'Pirelli'],
  ['metzeler', 'Metzeler'],
  ['michelin', 'Michelin'],
  ['bridgestone', 'Bridgestone'],
  ['dunlop', 'Dunlop'],
  ['levorin', 'Levorin'],
  ['rinaldi', 'Rinaldi'],
  ['maggion', 'Maggion'],
  ['magion', 'Maggion'],
  ['technic', 'Technic'],
  ['vipal', 'Vipal'],
  ['mitas', 'Mitas'],
  ['kenda', 'Kenda'],
]);

export const CATALOG_BRAND_STOCK_PROJECTION = `(
  SELECT CASE
           WHEN count(DISTINCT lower(btrim(p.brand)))
                  FILTER (WHERE NULLIF(btrim(p.brand),'') IS NOT NULL) = 1
           THEN min(btrim(p.brand)) FILTER (WHERE NULLIF(btrim(p.brand),'') IS NOT NULL)
           ELSE NULL
         END
    FROM commerce.products p
   WHERE p.environment=ws.environment
     AND p.deleted_at IS NULL
     AND EXISTS (
       SELECT 1 FROM commerce.tire_specs ts
        WHERE ts.environment=p.environment
          AND ts.product_id=p.id
          AND ts.tire_size=ws.measure
     )
)`;

function brandKey(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/** Padroniza as marcas conhecidas sem impedir uma marca nova de entrar no catálogo. */
export function canonicalCatalogBrand(value: string | null | undefined): string | null {
  const clean = value?.trim().replace(/\s+/g, ' ') ?? '';
  if (!clean) return null;
  return KNOWN_BRANDS.get(brandKey(clean)) ?? clean.slice(0, 60);
}

/**
 * A marca pertence ao produto do Catálogo, não à linha financeira nem ao saldo.
 * Como o galpão atual é consolidado por medida, uma marca informada nessa tela é
 * aplicada a todos os produtos ativos que usam a mesma medida oficial.
 */
export async function syncCatalogBrandForMeasure(
  db: Pool | PoolClient,
  input: {
    environment: 'prod' | 'test';
    measure: string;
    brand: string | null | undefined;
    actorLabel?: string | null;
    /** Ajuste manual pode corrigir a marca; entradas não podem misturar marcas com saldo existente. */
    allowReplace?: boolean;
  },
): Promise<string | null> {
  const brand = canonicalCatalogBrand(input.brand);
  if (!brand) return null;

  const products = await db.query<{ id: string; brand: string | null }>(
    `SELECT p.id,p.brand
       FROM commerce.products p
      WHERE p.environment=$1
        AND p.deleted_at IS NULL
        AND EXISTS (
          SELECT 1
            FROM commerce.tire_specs ts
           WHERE ts.environment=p.environment
             AND ts.product_id=p.id
             AND ts.tire_size=$2
        )
      ORDER BY p.id
      FOR UPDATE`,
    [input.environment, input.measure],
  );
  if (!products.rows.length) throw new Error('catalog_product_not_found');

  const changed = products.rows.filter((row) => row.brand !== brand);
  if (!changed.length) return brand;
  const existingBrands = new Set(products.rows.map((row) => canonicalCatalogBrand(row.brand)).filter(Boolean));
  if (existingBrands.size > 0 && !existingBrands.has(brand) && !input.allowReplace) {
    const stock = await db.query<{ quantity_on_hand: number }>(
      `SELECT quantity_on_hand
         FROM commerce.wholesale_stock
        WHERE environment=$1 AND measure=$2`,
      [input.environment, input.measure],
    );
    if (Number(stock.rows[0]?.quantity_on_hand ?? 0) > 0) {
      throw new Error('stock_measure_brand_conflict');
    }
  }

  await db.query(
    `UPDATE commerce.products
        SET brand=$3,updated_at=now()
      WHERE environment=$1 AND id=ANY($2::uuid[])`,
    [input.environment, changed.map((row) => row.id), brand],
  );
  for (const row of changed) {
    await db.query(
      `INSERT INTO audit.events
         (environment,domain,entity_table,entity_id,event_type,actor_label,
          payload_before,payload_after)
       VALUES ($1,'catalog','commerce.products',$2,'catalog_brand_changed',$3,$4::jsonb,$5::jsonb)`,
      [
        input.environment,
        row.id,
        input.actorLabel?.trim().slice(0, 120) || 'system:catalog-brand',
        JSON.stringify({ brand: row.brand, measure: input.measure }),
        JSON.stringify({ brand, measure: input.measure }),
      ],
    );
  }
  return brand;
}

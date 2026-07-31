import type { Pool } from 'pg';

type Queryable = Pick<Pool, 'query'>;

export const REQUIRED_SCHEMA_SQL = `
  SELECT
    EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema='commerce'
         AND table_name='wholesale_stock'
         AND column_name='brand'
         AND is_nullable='NO'
    )
    AND EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema='commerce'
         AND table_name='wholesale_stock_movements'
         AND column_name='brand'
         AND is_nullable='NO'
    )
    AND EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema='commerce'
         AND table_name='wholesale_order_items'
         AND column_name='brand'
         AND is_nullable='NO'
    )
    AND EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema='commerce'
         AND table_name='wholesale_purchase_items'
         AND column_name='brand'
         AND is_nullable='NO'
    )
    AND to_regclass('commerce.wholesale_stock_measure_brand_uniq') IS NOT NULL
    AND to_regclass('commerce.wholesale_stock_movements_measure_brand_idx') IS NOT NULL
    AS ready`;

/** Impede o processo novo de operar sobre um banco anterior à migration 0155. */
export async function assertRequiredSchema(db: Queryable): Promise<void> {
  const result = await db.query<{ ready: boolean }>(REQUIRED_SCHEMA_SQL);
  if (result.rows[0]?.ready !== true) {
    throw new Error('required_schema_missing:0155_wholesale_stock_multi_brand');
  }
}

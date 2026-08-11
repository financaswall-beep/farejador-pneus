import type { Pool } from 'pg';

type Queryable = Pick<Pool, 'query'>;

export const REQUIRED_SCHEMA_SQL = `
  SELECT
    EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema='commerce'
         AND table_name='wholesale_stock'
         AND column_name='tire_condition'
         AND is_nullable='NO'
    )
    AND EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema='commerce'
         AND table_name='wholesale_stock'
         AND column_name='quantity_reserved'
         AND is_nullable='NO'
    )
    AND EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema='commerce'
         AND table_name='orders'
         AND column_name='retrieved_at'
    )
    AND EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema='commerce'
         AND table_name='wholesale_stock_movements'
         AND column_name='tire_condition'
         AND is_nullable='NO'
    )
    AND EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema='commerce'
         AND table_name='wholesale_order_items'
         AND column_name='tire_condition'
         AND is_nullable='NO'
    )
    AND EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema='commerce'
         AND table_name='wholesale_purchase_items'
         AND column_name='tire_condition'
         AND is_nullable='NO'
    )
    AND to_regclass('commerce.wholesale_stock_variant_uniq') IS NOT NULL
    AND to_regclass('commerce.wholesale_stock_movements_variant_idx') IS NOT NULL
    AND to_regclass('commerce.partner_stock_routable_product_idx') IS NOT NULL
    AND EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema='core'
         AND table_name='messages'
         AND column_name='native_message_id'
    )
    AND to_regclass('raw.meta_messaging_events') IS NOT NULL
    AND to_regclass('marketing.meta_messaging_referrals') IS NOT NULL
    AND to_regclass('commerce.partner_item_registration_requests') IS NOT NULL
    AND to_regclass('commerce.partner_stock_count_requests') IS NOT NULL
    AS ready`;

/** Impede o processo novo de operar sobre um banco anterior à migration 0166. */
export async function assertRequiredSchema(db: Queryable): Promise<void> {
  const result = await db.query<{ ready: boolean }>(REQUIRED_SCHEMA_SQL);
  if (result.rows[0]?.ready !== true) {
    throw new Error('required_schema_missing:0166_partner_operation_inventory_requests');
  }
}

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
    AND to_regclass('commerce.partner_stock_count_evidence') IS NOT NULL
    AND EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema='commerce'
         AND table_name='partner_purchases'
         AND column_name='receipt_status'
         AND is_nullable='NO'
    )
    AND EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema='commerce'
         AND table_name='partner_purchase_items'
         AND column_name='received_quantity'
    )
    AND to_regclass('commerce.partner_purchases_receipt_idempotency_uniq') IS NOT NULL
    AND EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema='commerce'
         AND table_name='partner_purchase_items'
         AND column_name='received_stock_id'
    )
    AND EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema='commerce'
         AND table_name='partner_stock_levels'
         AND column_name='average_cost'
         AND numeric_scale=6
    )
    AND to_regclass('commerce.partner_stock_natural_key_uniq') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='commerce' AND table_name='wholesale_orders'
         AND column_name='partner_unit_id'
    )
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='commerce' AND table_name='partner_purchases'
         AND column_name='source_wholesale_order_id'
    )
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='commerce' AND table_name='partner_purchase_items'
         AND column_name='source_wholesale_order_item_id'
    )
    AND to_regclass('commerce.partner_purchases_source_wholesale_order_uniq') IS NOT NULL
    AND to_regclass('commerce.partner_purchase_items_source_wholesale_item_uniq') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='commerce' AND table_name='wholesale_orders'
         AND column_name='partner_transfer_status'
    )
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='commerce' AND table_name='wholesale_orders'
         AND column_name='partner_settled_at'
    )
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='commerce' AND table_name='wholesale_orders'
         AND column_name='partner_payment_terms'
    )
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='commerce' AND table_name='wholesale_order_items'
         AND column_name='accepted_quantity'
    )
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='commerce' AND table_name='partner_purchase_items'
         AND column_name='confirmed_quantity'
    )
    AND to_regclass('commerce.matrix_partner_cargo_lots') IS NOT NULL
    AND to_regclass('commerce.matrix_partner_cargo_events') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM pg_trigger
       WHERE tgrelid='commerce.wholesale_orders'::regclass
         AND tgname='matrix_partner_arrival_order_guard'
         AND NOT tgisinternal
    )
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='commerce' AND table_name='order_items'
         AND column_name='reference_unit_price' AND is_nullable='NO'
    )
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='commerce' AND table_name='partner_order_items'
         AND column_name='reference_unit_price' AND is_nullable='NO'
    )
    AND to_regclass('ops.application_schema_state') IS NOT NULL
    AS ready`;

export const REQUIRED_SCHEMA_STATE_SQL = `
  SELECT EXISTS (
    SELECT 1 FROM ops.application_schema_state
     WHERE singleton=true
       AND version>=199
  ) AS ready`;

/** Impede o processo novo de operar sobre um banco anterior à migration 0199. */
export async function assertRequiredSchema(db: Queryable): Promise<void> {
  const result = await db.query<{ ready: boolean }>(REQUIRED_SCHEMA_SQL);
  if (result.rows[0]?.ready !== true) {
    throw new Error('required_schema_missing:0199_system_continuity');
  }
  const state = await db.query<{ ready: boolean }>(REQUIRED_SCHEMA_STATE_SQL);
  if (state.rows[0]?.ready !== true) {
    throw new Error('required_schema_missing:0199_system_continuity');
  }
}

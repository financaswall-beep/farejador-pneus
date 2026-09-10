import type { Pool } from 'pg';

type Queryable = Pick<Pool, 'query'>;

export const REQUIRED_SCHEMA_SQL = `
  SELECT
    to_regclass('commerce.matriz_delivery_settings') IS NOT NULL
    AND to_regclass('commerce.matriz_delivery_settings_events') IS NOT NULL
    AND
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
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='commerce' AND table_name='orders'
         AND column_name='pickup_services' AND is_nullable='NO'
    )
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='commerce' AND table_name='partner_orders'
         AND column_name='pickup_services' AND is_nullable='NO'
    )
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='commerce' AND table_name='order_items'
         AND column_name='pickup_service_code'
    )
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='commerce' AND table_name='partner_order_items'
         AND column_name='pickup_service_code'
    )
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='commerce' AND table_name='vehicle_fitments'
         AND column_name='year_start'
    )
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='commerce' AND table_name='vehicle_fitments'
         AND column_name='year_end'
    )
    AND to_regprocedure('commerce.find_compatible_tires(env_t,uuid,text,integer)') IS NOT NULL
    AND to_regclass('ops.application_schema_state') IS NOT NULL
    AND to_regclass('ops.applied_migrations') IS NOT NULL
    AND to_regclass('finance.partner_receivable_events') IS NOT NULL
    AND to_regclass('finance.partner_payable_events') IS NOT NULL
    AND to_regclass('finance.partner_order_refunds') IS NOT NULL
    AND to_regclass('finance.partner_receivables_effective') IS NOT NULL
    AND to_regclass('finance.partner_payables_effective') IS NOT NULL
    AND to_regclass('ops.conversation_bot_control') IS NOT NULL
    AND to_regclass('ops.conversation_bot_control_events') IS NOT NULL
    AND to_regprocedure('analytics.extract_lead_location_facts(uuid)') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid='ops.outbound_messages'::regclass
         AND conname='outbound_messages_kind_check'
         AND pg_get_constraintdef(oid) LIKE '%conversation_resolution%'
    )
    AS ready`;

export const REQUIRED_SCHEMA_STATE_SQL = `
  SELECT EXISTS (
    SELECT 1 FROM ops.application_schema_state
     WHERE singleton=true
       AND version>=223
       AND EXISTS (
         SELECT 1 FROM ops.applied_migrations
          WHERE migration_file='0216_conversation_bot_control.sql'
            AND checksum_sha256='10c223869c6283a300b89348caae3cb062d1c55aabf39c00282890bdc34618b4'
       )
       AND EXISTS (
         SELECT 1 FROM ops.applied_migrations
          WHERE migration_file='0219_bot_conversation_lifecycle.sql'
            AND checksum_sha256='5b2e34392720996da7ae5de76e272421c1cb87ede6b827dcb4a102ba118c72ae'
       )
       AND EXISTS (
         SELECT 1 FROM ops.applied_migrations
          WHERE migration_file='0220_lead_location_memory.sql'
            AND checksum_sha256='b3d57df6dacfe9bfe89388a6749ec87755ebed0fada50eadc6f946d0a7b1c078'
       )
       AND EXISTS (
         SELECT 1 FROM ops.applied_migrations
          WHERE migration_file='0221_bot_analytics_trigger_isolation.sql'
            AND checksum_sha256='35f27b20f46b3dfc0cea1fc89abb691c3c6982215ef7ea2486ee069720528060'
       )
       AND EXISTS (
         SELECT 1 FROM ops.applied_migrations
          WHERE migration_file='0222_fitment_year_validity.sql'
            AND checksum_sha256='34d272e3b7ea6d544b5920836f34b09066120892b428f2ae3049bfd990df11ed'
       )
       AND EXISTS (
         SELECT 1 FROM ops.applied_migrations
          WHERE migration_file='0223_matriz_delivery_settings.sql'
            AND checksum_sha256='4fcf1d554d261ed00d0399134346bdbe95e12286f9e8d64bcb4609425d8420ef'
       )
       AND (SELECT count(*) FROM ops.applied_migrations)>=224
  ) AS ready`;

/** Impede o processo novo de operar sem o ciclo de vida e a memória de lead. */
export async function assertRequiredSchema(db: Queryable): Promise<void> {
  const result = await db.query<{ ready: boolean }>(REQUIRED_SCHEMA_SQL);
  if (result.rows[0]?.ready !== true) {
    throw new Error('required_schema_missing:0223_matriz_delivery_settings');
  }
  const state = await db.query<{ ready: boolean }>(REQUIRED_SCHEMA_STATE_SQL);
  if (state.rows[0]?.ready !== true) {
    throw new Error('required_schema_missing:0223_matriz_delivery_settings');
  }
}

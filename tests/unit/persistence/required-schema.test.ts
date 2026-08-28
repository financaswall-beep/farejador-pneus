import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import {
  assertRequiredSchema, REQUIRED_SCHEMA_SQL, REQUIRED_SCHEMA_STATE_SQL,
} from '../../../src/persistence/required-schema.js';

describe('schema mínimo exigido no boot', () => {
  it('aceita a estrutura multimarcas completa', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ready: true }] });
    await expect(assertRequiredSchema({ query } as unknown as Pool)).resolves.toBeUndefined();
    expect(query).toHaveBeenNthCalledWith(1, REQUIRED_SCHEMA_SQL);
    expect(query).toHaveBeenNthCalledWith(2, REQUIRED_SCHEMA_STATE_SQL);
    expect(REQUIRED_SCHEMA_SQL).toContain(`table_name='wholesale_order_items'`);
    expect(REQUIRED_SCHEMA_SQL).toContain(`table_name='wholesale_purchase_items'`);
    expect(REQUIRED_SCHEMA_SQL).toContain('wholesale_stock_movements_variant_idx');
    expect(REQUIRED_SCHEMA_SQL).toContain('partner_stock_routable_product_idx');
    expect(REQUIRED_SCHEMA_SQL).toContain(`column_name='native_message_id'`);
    expect(REQUIRED_SCHEMA_SQL).toContain(`to_regclass('raw.meta_messaging_events')`);
    expect(REQUIRED_SCHEMA_SQL).toContain(`to_regclass('marketing.meta_messaging_referrals')`);
    expect(REQUIRED_SCHEMA_SQL).toContain(`to_regclass('commerce.partner_item_registration_requests')`);
    expect(REQUIRED_SCHEMA_SQL).toContain(`to_regclass('commerce.partner_stock_count_requests')`);
    expect(REQUIRED_SCHEMA_SQL).toContain(`to_regclass('commerce.partner_stock_count_evidence')`);
    expect(REQUIRED_SCHEMA_SQL).toContain(`table_name='partner_purchases'`);
    expect(REQUIRED_SCHEMA_SQL).toContain(`column_name='receipt_status'`);
    expect(REQUIRED_SCHEMA_SQL).toContain(`column_name='received_quantity'`);
    expect(REQUIRED_SCHEMA_SQL).toContain('partner_purchases_receipt_idempotency_uniq');
    expect(REQUIRED_SCHEMA_SQL).toContain(`column_name='received_stock_id'`);
    expect(REQUIRED_SCHEMA_SQL).toContain('numeric_scale=6');
    expect(REQUIRED_SCHEMA_SQL).toContain('partner_stock_natural_key_uniq');
    expect(REQUIRED_SCHEMA_SQL).toContain(`column_name='partner_unit_id'`);
    expect(REQUIRED_SCHEMA_SQL).toContain(`column_name='source_wholesale_order_id'`);
    expect(REQUIRED_SCHEMA_SQL).toContain(`column_name='source_wholesale_order_item_id'`);
    expect(REQUIRED_SCHEMA_SQL).toContain('partner_purchases_source_wholesale_order_uniq');
    expect(REQUIRED_SCHEMA_SQL).toContain(`column_name='partner_transfer_status'`);
    expect(REQUIRED_SCHEMA_SQL).toContain(`column_name='partner_payment_terms'`);
    expect(REQUIRED_SCHEMA_SQL).toContain(`column_name='accepted_quantity'`);
    expect(REQUIRED_SCHEMA_SQL).toContain(`column_name='confirmed_quantity'`);
    expect(REQUIRED_SCHEMA_SQL).toContain(`to_regclass('commerce.matrix_partner_cargo_lots')`);
    expect(REQUIRED_SCHEMA_SQL).toContain(`tgname='matrix_partner_arrival_order_guard'`);
    expect(REQUIRED_SCHEMA_SQL).toContain(`table_name='order_items'`);
    expect(REQUIRED_SCHEMA_SQL).toContain(`table_name='partner_order_items'`);
    expect(REQUIRED_SCHEMA_SQL).toContain(`column_name='reference_unit_price'`);
    expect(REQUIRED_SCHEMA_SQL).toContain(`column_name='pickup_services'`);
    expect(REQUIRED_SCHEMA_SQL).toContain(`column_name='pickup_service_code'`);
    expect(REQUIRED_SCHEMA_SQL).toContain("to_regclass('ops.application_schema_state')");
    expect(REQUIRED_SCHEMA_SQL).toContain("to_regclass('ops.applied_migrations')");
    expect(REQUIRED_SCHEMA_SQL).toContain("to_regclass('finance.partner_receivable_events')");
    expect(REQUIRED_SCHEMA_SQL).toContain("to_regclass('finance.partner_payable_events')");
    expect(REQUIRED_SCHEMA_SQL).toContain("to_regclass('finance.partner_order_refunds')");
    expect(REQUIRED_SCHEMA_SQL).toContain("to_regclass('finance.partner_receivables_effective')");
    expect(REQUIRED_SCHEMA_SQL).toContain("to_regclass('finance.partner_payables_effective')");
    expect(REQUIRED_SCHEMA_STATE_SQL).toContain('version>=214');
    expect(REQUIRED_SCHEMA_STATE_SQL).toContain(
      "migration_file='0214_purchase_adjustment_reconciliation_health.sql'",
    );
    expect(REQUIRED_SCHEMA_STATE_SQL).toContain(
      "checksum_sha256='9f0352758eea351a63a83cd71955ae0a5776ea8039b82fe6e408fa21ad3bb481'",
    );
    expect(REQUIRED_SCHEMA_STATE_SQL).toContain('count(*) FROM ops.applied_migrations)>=215');
    expect(REQUIRED_SCHEMA_STATE_SQL).not.toContain("migration_name='0199_system_continuity.sql'");
  });

  it('recusa iniciar antes da migration 0214', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ready: false }] });
    await expect(assertRequiredSchema({ query } as unknown as Pool))
      .rejects.toThrow('required_schema_missing:0214_purchase_adjustment_health');
  });
});

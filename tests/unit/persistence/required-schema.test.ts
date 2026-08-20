import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import {
  assertRequiredSchema, REQUIRED_SCHEMA_SQL,
} from '../../../src/persistence/required-schema.js';

describe('schema mínimo exigido no boot', () => {
  it('aceita a estrutura multimarcas completa', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ready: true }] });
    await expect(assertRequiredSchema({ query } as unknown as Pool)).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledWith(REQUIRED_SCHEMA_SQL);
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
  });

  it('recusa iniciar antes da migration 0189', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ready: false }] });
    await expect(assertRequiredSchema({ query } as unknown as Pool))
      .rejects.toThrow('required_schema_missing:0189_checkout_price_negotiation');
  });
});

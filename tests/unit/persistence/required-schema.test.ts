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
  });

  it('recusa iniciar antes da migration 0166', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ready: false }] });
    await expect(assertRequiredSchema({ query } as unknown as Pool))
      .rejects.toThrow('required_schema_missing:0166_partner_operation_inventory_requests');
  });
});

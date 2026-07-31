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
    expect(REQUIRED_SCHEMA_SQL).toContain('wholesale_stock_movements_measure_brand_idx');
  });

  it('recusa iniciar antes da migration 0155', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ready: false }] });
    await expect(assertRequiredSchema({ query } as unknown as Pool))
      .rejects.toThrow('required_schema_missing:0155_wholesale_stock_multi_brand');
  });
});

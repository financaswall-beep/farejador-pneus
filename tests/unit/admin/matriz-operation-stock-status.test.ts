import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

vi.mock('../../../src/shared/config/env.js', () => ({ env: { FAREJADOR_ENV: 'test' } }));
vi.mock('../../../src/persistence/db.js', () => ({ pool: {} }));

import { getMatrizOperationStock } from '../../../src/admin/caixa/operation-stock.js';

describe('status do estoque da matriz no app operacional', () => {
  it('distingue físico zerado, totalmente reservado, baixo e disponível', async () => {
    const base = {
      id: 'stock', measure: '90/90-18', brand: 'Pirelli', tire_condition: 'novo',
      min_quantity: 4, updated_at: '2026-08-17T12:00:00Z',
      tire_width_mm: 90, tire_aspect_ratio: 90, tire_rim_diameter: 18,
    };
    const db = {
      query: async () => ({ rows: [
        { ...base, id: 'zero', quantity_on_hand: 0, quantity_reserved: 0, quantity_available: 0 },
        { ...base, id: 'reserved', quantity_on_hand: 5, quantity_reserved: 5, quantity_available: 0 },
        { ...base, id: 'low', quantity_on_hand: 5, quantity_reserved: 1, quantity_available: 4 },
        { ...base, id: 'ok', quantity_on_hand: 8, quantity_reserved: 1, quantity_available: 7 },
      ] }),
    } as unknown as Pool;

    const result = await getMatrizOperationStock(db);
    expect(result.rows.map((row) => [row.stock_id, row.stock_status])).toEqual([
      ['zero', 'out_of_stock'],
      ['reserved', 'reserved'],
      ['low', 'low_stock'],
      ['ok', 'in_stock'],
    ]);
  });
});

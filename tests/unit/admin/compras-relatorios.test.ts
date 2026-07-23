import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/persistence/db.js', () => ({ pool: {} }));
vi.mock('../../../src/shared/config/env.js', () => ({ env: { FAREJADOR_ENV: 'test' } }));

import {
  getWholesalePriceReport,
  getWholesalePurchaseReport,
  getWholesaleSupplierInsights,
} from '../../../src/admin/painel/queries-compras-relatorios.js';

describe('relatórios conciliados de compras', () => {
  it('pagina o histórico e mantém recebimento separado do compromisso financeiro', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        rows_count: 21, purchases_count: 20, received_tires: 48,
        total_committed: '1234.56', pending_receipts: 2, open_payments: 3,
      }] })
      .mockResolvedValueOnce({ rows: [{ id: 'purchase-1', items: [] }] });
    const report = await getWholesalePurchaseReport({
      period: '30d', status: 'all', payment: 'all',
      search: '90/90', page: 2, pageSize: 10,
    }, 'test', { query } as unknown as Pool);

    expect(report.summary).toMatchObject({
      purchases_count: 20, received_tires: 48,
      pending_receipts: 2, open_payments: 3,
    });
    expect(report.pagination).toEqual({ page: 2, page_size: 10, total: 21, pages: 3 });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]![1]).toEqual(['test', '%90/90%']);
    expect(query.mock.calls[1]![1]).toEqual(['test', '%90/90%', 10, 10]);
    expect(query.mock.calls[0]![0]).toContain(`status='confirmed'`);
    expect(query.mock.calls[0]![0]).toContain(`status<>'cancelled'`);
  });

  it('expõe fornecedor ativo com compromisso e medidas recebidas', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      supplier_id: 'supplier-1', purchases_count: 3, pending_receipts: 1,
      total_spent: '300.00', measures: [{ measure: '90/90-18', qty_total: 4 }],
    }] });
    const rows = await getWholesaleSupplierInsights('test', { query } as unknown as Pool);

    expect(rows).toHaveLength(1);
    expect(query.mock.calls[0]![0]).toContain(`p.status<>'cancelled'`);
    expect(query.mock.calls[0]![0]).toContain(`cp.status='confirmed'`);
    expect(query.mock.calls[0]![1]).toEqual(['test']);
  });

  it('compara preço somente de compra recebida e aceita recorte seguro', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await getWholesalePriceReport({
      period: '90d', supplierId: '11111111-1111-4111-8111-111111111111',
      search: '100/80',
    }, 'test', { query } as unknown as Pool);

    expect(query.mock.calls[0]![0]).toContain(`p.status='confirmed'`);
    expect(query.mock.calls[0]![0]).toContain(`interval '90 days'`);
    expect(query.mock.calls[0]![1]).toEqual([
      'test', '11111111-1111-4111-8111-111111111111', '%100/80%',
    ]);
  });
});

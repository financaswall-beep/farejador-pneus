import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { getCaixaMySaleDetail, getCaixaMySales } from '../../../src/admin/caixa/my-sales.js';

vi.mock('../../../src/persistence/db.js', () => ({ pool: {} }));

describe('Minhas vendas da Matriz', () => {
  it('amarra resumo e lista ao colaborador autenticado', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        date: '2026-08-10', sales_count: 1, revenue: '399.80',
        items_quantity: 2, commission_amount: '19.99',
      }] })
      .mockResolvedValueOnce({ rows: [{
        order_id: '11111111-1111-4111-8111-111111111111', order_number: 'PED-1052',
        payment_method: 'pix', total_amount: '399.80', status: 'confirmed',
        created_at: '2026-08-10T13:42:00Z', items_quantity: 2, item_kind: 'pneu',
        first_name: 'MAGGION 90/90-18', item_lines: 1, commission_kind: 'percent',
        commission_basis: 'revenue', commission_value: '5', commission_amount: '19.99',
        payroll_status: null,
      }] });
    const db = { query } as unknown as Pool;

    const result = await getCaixaMySales('prod', 'collaborator-wallace', 0, db);

    expect(result.summary).toMatchObject({ sales_count: 1, revenue: 399.8, commission_amount: 19.99 });
    expect(result.sales[0]).toMatchObject({ item_summary: 'MAGGION 90/90-18', commission_status: 'receivable' });
    expect(query.mock.calls[0]?.[1]).toEqual(['prod', 'collaborator-wallace', 0]);
    expect(query.mock.calls[1]?.[1]).toEqual(['prod', 'collaborator-wallace', 0]);
    const sql = query.mock.calls.map((call) => String(call[0])).join('\n');
    expect(sql).toContain('o.seller_collaborator_id=$2');
    expect(sql).not.toContain('customer_name');
  });

  it('não abre detalhes de uma venda sem repetir o colaborador no filtro', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] });
    const db = { query } as unknown as Pool;

    expect(await getCaixaMySaleDetail(
      'test', 'collaborator-ana', '22222222-2222-4222-8222-222222222222', db,
    )).toBeNull();
    expect(query.mock.calls[0]?.[1]).toEqual([
      'test', 'collaborator-ana', '22222222-2222-4222-8222-222222222222',
    ]);
    expect(String(query.mock.calls[0]?.[0])).toContain('o.seller_collaborator_id=$2');
  });
});

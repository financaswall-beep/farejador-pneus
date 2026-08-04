import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { getCaixaSaleReceipt, getCaixaSales } from '../../../src/admin/caixa/sales.js';

vi.mock('../../../src/persistence/db.js', () => ({ pool: {} }));

describe('consultas da aba Vendas do caixa', () => {
  it('resume e lista somente o varejo da Matriz no período selecionado', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ sales_count: 2, revenue: '528.90', average_ticket: '264.45' }] })
      .mockResolvedValueOnce({ rows: [{
        order_id: '11111111-1111-4111-8111-111111111111',
        order_number: 'PED-1048',
        customer_name: 'Cliente Balcão',
        payment_method: 'pix',
        total_amount: '308.90',
        status: 'confirmed',
        created_at: '2026-08-04T13:00:00.000Z',
        items_quantity: 2,
        item_kind: 'pneu',
      }] });
    const dbPool = { query } as unknown as Pool;

    const payload = await getCaixaSales('prod', '7d', 'Cliente', dbPool);

    expect(payload.summary).toEqual({ sales_count: 2, revenue: 528.9, average_ticket: 264.45 });
    expect(payload.sales[0]).toMatchObject({ order_number: 'PED-1048', total_amount: 308.9 });
    expect(query).toHaveBeenCalledTimes(2);
    const sql = query.mock.calls.map((call) => String(call[0])).join('\n');
    expect(sql).toContain("u.slug='main'");
    expect(sql).toContain("INTERVAL '6 days'");
    expect(sql).toContain("o.status<>'cancelled'");
    expect(query.mock.calls[1]?.[1]).toEqual(['prod', '%Cliente%']);
  });

  it('protege curingas da busca e limita o texto recebido', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ sales_count: 0, revenue: '0', average_ticket: '0' }] })
      .mockResolvedValueOnce({ rows: [] });
    const dbPool = { query } as unknown as Pool;

    await getCaixaSales('test', 'today', '  10%_off  ', dbPool);

    expect(query.mock.calls[1]?.[1]).toEqual(['test', '%10\\%\\_off%']);
  });

  it('retorna recibo apenas quando o pedido pertence à unidade main', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{
      order_id: '22222222-2222-4222-8222-222222222222',
      order_number: null,
      customer_name: 'Marcos Silva',
      payment_method: 'cartao',
      total_amount: '219.90',
      status: 'confirmed',
      created_at: '2026-08-04T13:00:00.000Z',
      seller_name: 'Ana',
      items: [{ product_name: 'Pneu 90/90-18', quantity: 1, unit_price: '219.90', discount_amount: '0', line_total: '219.90' }],
    }] });
    const dbPool = { query } as unknown as Pool;

    const receipt = await getCaixaSaleReceipt(
      'prod',
      '22222222-2222-4222-8222-222222222222',
      dbPool,
    );

    expect(receipt).toMatchObject({ total_amount: 219.9, seller_name: 'Ana' });
    expect(receipt?.items[0]).toMatchObject({ unit_price: 219.9, line_total: 219.9 });
    expect(String(query.mock.calls[0]?.[0])).toContain("u.slug='main'");
  });
});

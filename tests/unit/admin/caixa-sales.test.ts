import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { getCaixaSaleReceipt, getCaixaSales } from '../../../src/admin/caixa/sales.js';

vi.mock('../../../src/persistence/db.js', () => ({ pool: {} }));

describe('consultas da aba Vendas do caixa', () => {
  it('resume e lista somente o varejo da Matriz no período selecionado', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        sales_count: 2,
        revenue: '528.90',
        average_ticket: '264.45',
        items_quantity: '3',
        pix_revenue: '308.90',
        card_revenue: '220.00',
        cash_revenue: '0',
        other_revenue: '0',
      }] })
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
      }] })
      .mockResolvedValueOnce({ rows: [
        { date: '2026-07-27', sales_count: 0, revenue: '0' },
        { date: '2026-07-28', sales_count: 1, revenue: '220.00' },
        { date: '2026-07-29', sales_count: 0, revenue: '0' },
        { date: '2026-07-30', sales_count: 0, revenue: '0' },
        { date: '2026-07-31', sales_count: 0, revenue: '0' },
        { date: '2026-08-01', sales_count: 0, revenue: '0' },
        {
          date: '2026-08-02',
          sales_count: 1,
          revenue: '308.90',
          average_ticket: '308.90',
          items_quantity: '2',
          pix_revenue: '308.90',
          card_revenue: '0',
          cash_revenue: '0',
          other_revenue: '0',
        },
      ] });
    const dbPool = { query } as unknown as Pool;

    const payload = await getCaixaSales('prod', '7d', 'Cliente', -1, dbPool);

    expect(payload.week_offset).toBe(-1);
    expect(payload.summary).toEqual({
      sales_count: 2,
      revenue: 528.9,
      average_ticket: 264.45,
      items_quantity: 3,
      pix_revenue: 308.9,
      card_revenue: 220,
      cash_revenue: 0,
      other_revenue: 0,
    });
    expect(payload.daily_series).toHaveLength(7);
    expect(payload.daily_series[6]).toEqual({
      date: '2026-08-02',
      sales_count: 1,
      revenue: 308.9,
      average_ticket: 308.9,
      items_quantity: 2,
      pix_revenue: 308.9,
      card_revenue: 0,
      cash_revenue: 0,
      other_revenue: 0,
    });
    expect(payload.sales[0]).toMatchObject({ order_number: 'PED-1048', total_amount: 308.9 });
    expect(query).toHaveBeenCalledTimes(3);
    const sql = query.mock.calls.map((call) => String(call[0])).join('\n');
    expect(sql).toContain("u.slug='main'");
    expect(sql).toContain("date_trunc('week'");
    expect(sql).toContain("INTERVAL '7 days'");
    expect(sql).toContain("o.status IN ('confirmed','paid','delivered')");
    expect(query.mock.calls[0]?.[1]).toEqual(['prod', -1]);
    expect(query.mock.calls[1]?.[1]).toEqual(['prod', '%Cliente%', -1]);
    expect(query.mock.calls[2]?.[1]).toEqual(['prod', -1]);
  });

  it('protege curingas da busca e limita o texto recebido', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ sales_count: 0, revenue: '0', average_ticket: '0' }] })
      .mockResolvedValueOnce({ rows: [] });
    const dbPool = { query } as unknown as Pool;

    await getCaixaSales('test', 'today', '  10%_off  ', 0, dbPool);

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

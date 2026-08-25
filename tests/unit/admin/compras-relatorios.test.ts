import type { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/persistence/db.js', () => ({ pool: {} }));
vi.mock('../../../src/shared/config/env.js', () => ({ env: { FAREJADOR_ENV: 'test' } }));

import {
  getWholesalePriceReport,
  getWholesalePurchaseAnalytics,
  getWholesalePurchaseReport,
  getWholesaleSupplierInsights,
} from '../../../src/admin/painel/queries-compras-relatorios.js';
import {
  getWholesaleSupplierMeasureBreakdown,
} from '../../../src/admin/painel/queries-fornecedores.js';

describe('relatórios conciliados de compras', () => {
  it('expõe a análise visual do histórico e o detalhamento clicável de custo', () => {
    const html = readFileSync(resolve('painel/public/index.html'), 'utf8');
    expect(html).toContain('Total contratado');
    expect(html).toContain('Compras e recebimentos');
    expect(html).toContain('Custo médio geral');
    expect(html).toContain('@click="comprasOpenCostDialog()"');
    expect(html).toContain('Evolução do custo médio');
    expect(html).toContain('Compras canceladas ficam fora');
    expect(html).toContain('/admin/painel/app.compras.relatorios.js?v=20260825-purchase-history2');
  });

  it('mantém filtros compactos nas ordens e separa o custo do gráfico principal', () => {
    const html = readFileSync(resolve('painel/public/index.html'), 'utf8');
    const css = readFileSync(resolve('painel/public/tailwind.css'), 'utf8');
    const tableStart = html.indexOf('id="compras-history-table"');
    const tableTag = html.indexOf('<table', tableStart);
    const filters = html.slice(tableStart, tableTag);
    const costStart = html.indexOf('x-show="comprasCostDialogOpen"');
    const costEnd = html.indexOf('<!-- FORNECEDORES', costStart);
    const costDialog = html.slice(costStart, costEnd);

    expect(tableStart).toBeGreaterThan(0);
    expect(filters).toContain('Ordens e compras');
    expect(filters).toContain('lg:grid-cols-[minmax(180px,240px)');
    expect(filters).toContain('lg:justify-start');
    expect(filters).toContain('x-model="comprasHistoryFilters.search"');
    expect(filters).toContain('x-model="comprasHistoryFilters.supplierId"');
    expect(filters).toContain('x-model="comprasHistoryFilters.status"');
    expect(filters).toContain('x-model="comprasHistoryFilters.payment"');
    expect(filters).toContain('border-emerald-800 bg-emerald-800');
    expect(css).toContain(
      'grid-template-columns:minmax(180px,240px) minmax(160px,200px) 150px 150px 96px',
    );
    expect(costDialog).toContain('x-model="comprasCost.filters.supplierId"');
    expect(costDialog).toContain('loadComprasCostAnalysis()');
    expect(costDialog).toContain('Este filtro não altera compras, recebimentos nem a tabela.');
    expect(costDialog).not.toContain('comprasHistoryFilters');
    expect(html).toContain('@mouseenter="comprasHistoryHoverIndex=index"');
    expect(html).toContain('comprasHistoryHoverDetail(comprasHistoryHoveredRow())');
  });

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

  it('calcula custo ponderado, caixa e obrigação sem misturar recebimento', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        purchases_count: 1, total_committed: '22.00', paid_amount: '0.00',
        open_amount: '22.00', tires: 2, received_tires: 0, in_transit_tires: 2,
        active_suppliers: 1, average_cost: '11.00', minimum_item_cost: '11.00',
        maximum_item_cost: '11.00',
      }] })
      .mockResolvedValueOnce({ rows: [{
        bucket: '2026-08-25', total_committed: '22.00', tires: 2,
        received_tires: 0, average_cost: '11.00',
      }] })
      .mockResolvedValueOnce({ rows: [{ average_cost: '10.00' }] });
    const analytics = await getWholesalePurchaseAnalytics({
      period: '30d', status: 'all', payment: 'all',
      supplierId: '11111111-1111-4111-8111-111111111111',
      page: 1, pageSize: 10,
    }, 'test', { query } as unknown as Pool);

    expect(analytics.summary).toMatchObject({
      total_committed: '22.00', paid_amount: '0.00', open_amount: '22.00',
      tires: 2, in_transit_tires: 2, average_cost: '11.00',
      previous_average_cost: '10.00', average_change_pct: '10.0',
    });
    expect(analytics.timeline).toHaveLength(1);
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[0]![0]).toContain('matriz_ledger_obligation_balance');
    expect(query.mock.calls[0]![0]).toContain('sum(allocated)');
    expect(query.mock.calls[1]![0]).toContain("date_trunc('day'");
    expect(query.mock.calls[2]![0]).toContain("interval '60 days'");
    expect(query.mock.calls[0]![1]).toEqual([
      'test', '11111111-1111-4111-8111-111111111111',
    ]);
  });

  it('compara preço somente de compra recebida e aceita recorte seguro', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await getWholesalePriceReport({
      period: '90d', supplierId: '11111111-1111-4111-8111-111111111111',
      search: '100/80',
    }, 'test', { query } as unknown as Pool);

    expect(query.mock.calls[0]![0]).toContain(`p.status='confirmed'`);
    expect(query.mock.calls[0]![0]).toContain(`interval '90 days'`);
    expect(query.mock.calls[0]![0]).toContain(`i.measure,i.brand`);
    expect(query.mock.calls[0]![0]).toContain(`GROUP BY s.id,i.measure,i.brand`);
    expect(query.mock.calls[0]![0]).toContain(`lower(i.brand) LIKE`);
    expect(query.mock.calls[0]![1]).toEqual([
      'test', '11111111-1111-4111-8111-111111111111', '%100/80%',
    ]);
  });

  it('mantém marca na comparação resumida de fornecedores', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await getWholesaleSupplierMeasureBreakdown('test', { query } as unknown as Pool);

    expect(query.mock.calls[0]![0]).toContain(`pi.measure,pi.brand`);
    expect(query.mock.calls[0]![0]).toContain(`GROUP BY s.id,s.name,pi.measure,pi.brand`);
  });
});

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadModule(file: string, name: string) {
  const sandbox = { window: { PAINEL_MODULES: {} }, console, setTimeout };
  vm.runInNewContext(readFileSync(file, 'utf8'), sandbox);
  return sandbox.window.PAINEL_MODULES[name]();
}

describe('estoque oficial no navegador da matriz', () => {
  it('explica antes do envio quando o custo oficial bloqueia o produto', () => {
    const module = loadModule('painel/public/app.format.js', 'format');
    const context = {
      produtos: [{ product_id: 'p1', walkin_sellable: false, walkin_block_reason: 'walkin_cost_missing' }],
      saleForm: { product_id: 'p1', quantity: 1 },
      selectedProduct: module.selectedProduct,
    };
    expect(module.saleStockError.call(context)).toBe(
      'Essa medida estÃ¡ sem custo no galpÃ£o. Cadastre o custo antes de vender.',
    );
  });

  it('recusa quantidade maior que a fonte oficial', () => {
    const module = loadModule('painel/public/app.format.js', 'format');
    const context = {
      produtos: [{ product_id: 'p1', walkin_sellable: true, official_quantity_on_hand: 2 }],
      saleForm: { product_id: 'p1', quantity: 3 },
      selectedProduct: module.selectedProduct,
    };
    expect(module.saleStockError.call(context)).toBe('SÃ³ tem 2 dessa medida no galpÃ£o.');
  });

  it('carrega a conciliacao somente leitura pelo endpoint dedicado', async () => {
    const module = loadModule('painel/public/app.galpao.js', 'galpao');
    const report = { summary: { total: 4, divergent: 3 }, rows: [{ key: '90-90-18' }] };
    const context = {
      stockReconciliation: { loading: false, error: null, summary: null, rows: [] },
      apiGet: vi.fn().mockResolvedValue(report),
    };
    await module.loadStockReconciliation.call(context);
    expect(context.apiGet).toHaveBeenCalledWith('/admin/api/wholesale/stock/reconciliation');
    expect(context.stockReconciliation.summary).toEqual(report.summary);
    expect(context.stockReconciliation.rows).toEqual(report.rows);
  });
});

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function vendaModalModule(alert = vi.fn()) {
  const sandbox = { window: { PAINEL_MODULES: {}, alert }, crypto };
  vm.runInNewContext(
    readFileSync('painel/public/app.venda.modal.js', 'utf8'),
    sandbox,
  );
  return {
    module: sandbox.window.PAINEL_MODULES.vendaModal(),
    alert,
  };
}

describe('atualização do catálogo antes da venda de balcão', () => {
  it('seleciona o produto usando o estoque mais recente do servidor', async () => {
    const { module } = vendaModalModule();
    const fresh = {
      product_id: 'produto-atual',
      walkin_sellable: true,
      price_amount: 89,
      stock_quantity: 5,
    };
    const context = {
      produtos: [{
        product_id: 'produto-antigo',
        walkin_sellable: true,
        price_amount: 45,
        stock_quantity: 1,
      }],
      apiGet: vi.fn().mockResolvedValue({ rows: [fresh] }),
      applyProdutos: vi.fn(function (this: { produtos: unknown[] }, rows: unknown[]) {
        this.produtos = rows;
      }),
      modalConv: null,
      saleForm: {},
      orderError: 'erro antigo',
      saleModalOpen: false,
    };

    await module.openWalkinModal.call(context);

    expect(context.apiGet).toHaveBeenCalledWith('/admin/api/dashboard/produtos?limit=100');
    expect(context.applyProdutos).toHaveBeenCalledWith([fresh]);
    expect(context.saleForm).toMatchObject({
      product_id: 'produto-atual',
      unit_price: 89,
    });
    expect(context.saleModalOpen).toBe(true);
  });

  it('não abre a venda com fotografia antiga quando a atualização falha', async () => {
    const { module, alert } = vendaModalModule();
    const context = {
      produtos: [{ product_id: 'produto-antigo', walkin_sellable: true, price_amount: 45 }],
      apiGet: vi.fn().mockRejectedValue(new Error('api_503')),
      applyProdutos: vi.fn(),
      modalConv: null,
      saleForm: {},
      orderError: null,
      saleModalOpen: false,
    };

    await module.openWalkinModal.call(context);

    expect(alert).toHaveBeenCalledOnce();
    expect(context.saleModalOpen).toBe(false);
    expect(context.applyProdutos).not.toHaveBeenCalled();
  });
});

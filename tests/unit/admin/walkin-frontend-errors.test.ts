import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function pedidosModule() {
  const sandbox = { window: { PAINEL_MODULES: {} }, Error };
  vm.runInNewContext(
    readFileSync('painel/public/app.pedidos.parceiros.js', 'utf8'),
    sandbox,
  );
  return sandbox.window.PAINEL_MODULES.pedidosParceiros();
}

async function submitWalkinWithError(code: string) {
  const module = pedidosModule();
  const context = {
    orderSubmitting: false,
    orderError: null as string | null,
    modalConv: null,
    saleModalOpen: true,
    saleForm: {
      product_id: 'produto-1',
      quantity: 1,
      unit_price: 100,
      fulfillment_mode: 'pickup',
      delivery_address: '',
      payment_method: 'pix',
      idempotency_key: 'walkin-teste-1',
      source_tag: 'walkin_balcao',
      customer_name: '',
      customer_phone: '',
    },
    apiPost: vi.fn().mockRejectedValue(new Error(code)),
    loadRealData: vi.fn(),
    loadVarejoResumo: vi.fn(),
  };

  await module.submitManualOrder.call(context);
  return context.orderError;
}

describe('mensagens da venda de balcão da matriz', () => {
  it.each([
    ['walkin_measure_not_found', 'Esse pneu não está cadastrado no estoque do galpão.'],
    ['walkin_cost_missing', 'Essa medida está sem custo no galpão. Cadastre o custo antes de vender.'],
    ['walkin_stock_insufficient', 'Não há pneus suficientes dessa medida no galpão. Confira o estoque e tente novamente.'],
    ['walkin_stock_ambiguous', 'Essa medida tem mais de um cadastro no galpão. Corrija o estoque antes de vender.'],
    ['walkin_idempotency_conflict', 'Os dados dessa venda mudaram durante o envio. Feche, abra novamente e confira antes de finalizar.'],
  ])('traduz %s para o vendedor', async (code, expected) => {
    await expect(submitWalkinWithError(code)).resolves.toBe(expected);
  });

  it('não mostra código técnico inesperado', async () => {
    await expect(submitWalkinWithError('internal_server_error')).resolves.toBe(
      'Não consegui registrar a venda. Confira os dados e tente novamente.',
    );
  });
});

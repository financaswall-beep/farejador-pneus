import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadModule() {
  const integrity = {
    operation: vi.fn(() => ({ key: 'finance-test-key' })),
    complete: vi.fn(),
  };
  const sandbox = {
    window: { PAINEL_MODULES: {}, PAINEL_INTEGRITY: integrity, lucide: null },
    console,
    URLSearchParams,
  };
  vm.runInNewContext(
    readFileSync('painel/public/app.financeiro.baixas.js', 'utf8'),
    sandbox,
  );
  return {
    module: sandbox.window.PAINEL_MODULES.financeiroBaixas(),
    integrity,
  };
}

describe('baixa pela porta unica do Financeiro', () => {
  it('registra detalhes auditaveis e fecha o modal depois do sucesso', async () => {
    const { module, integrity } = loadModule();
    const apiPost = vi.fn().mockResolvedValue({ settled: true });
    const context = {
      ...module,
      adminUser: { role: 'owner' },
      finQuitando: false,
      finBaixaModal: {
        open: true,
        item: { id: 'expense-1', tipo: 'despesa', valor: 120 },
        direction: 'payable',
        amount: '120,00',
        payment_date: '2026-07-27',
        payment_method: 'pix',
        cash_account: 'Caixa principal',
        note: 'comprovante 42',
        error: null,
      },
      apiPost,
      loadFinanceiro: vi.fn(),
      loadSino: vi.fn(),
      loadFinExtrato: vi.fn(),
      $nextTick: vi.fn(),
    };

    await module.finConfirmarBaixa.call(context);

    expect(apiPost).toHaveBeenCalledWith(
      '/admin/api/matriz/financeiro/settle',
      expect.objectContaining({
        settlement_mode: 'expense',
        target_id: 'expense-1',
        amount: undefined,
        payment_method: 'pix',
        cash_account: 'Caixa principal',
        note: 'comprovante 42',
        idempotency_key: 'finance-test-key',
      }),
    );
    expect(context.finBaixaModal.open).toBe(false);
    expect(context.finBaixaModal.item).toBeNull();
    expect(integrity.complete).toHaveBeenCalledOnce();
  });
});

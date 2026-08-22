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
    readFileSync('painel/public/business-time.js', 'utf8'),
    sandbox,
  );
  vm.runInNewContext(
    readFileSync('painel/public/app.format.js', 'utf8'),
    sandbox,
  );
  vm.runInNewContext(
    readFileSync('painel/public/app.financeiro.baixas.js', 'utf8'),
    sandbox,
  );
  return {
    module: {
      ...sandbox.window.PAINEL_MODULES.format(),
      ...sandbox.window.PAINEL_MODULES.financeiroBaixas(),
    },
    integrity,
  };
}

describe('baixa pela porta unica do Financeiro', () => {
  it.each([
    ['121,55', 121.55],
    ['121.55', 121.55],
    ['1.234,56', 1234.56],
    ['1,234.56', 1234.56],
  ])('aceita valor financeiro com separadores brasileiros ou internacionais (%s)', (
    input, expected,
  ) => {
    const { module } = loadModule();
    expect(module.finParseValor(input)).toBe(expected);
  });

  it('revalida o modal e envia depois que o operador corrige um valor invalido', async () => {
    const { module } = loadModule();
    const apiPost = vi.fn().mockResolvedValue({ settled: true });
    const context = {
      ...module,
      adminUser: { role: 'owner' },
      finQuitando: false,
      finBaixaModal: {
        open: true,
        item: {
          id: 'ledger-item-retry',
          tipo: 'varejo',
          valor: 121.55,
          settlement_mode: 'retail_sale',
          obligation_id: '11111111-1111-4111-8111-111111111111',
        },
        direction: 'receivable',
        amount: '0',
        payment_date: '2026-07-27',
        payment_method: 'pix',
        cash_account: 'Caixa principal',
        note: '',
        error: null,
      },
      apiPost,
      loadFinanceiro: vi.fn(),
      loadSino: vi.fn(),
      loadFinExtrato: vi.fn(),
      $nextTick: vi.fn(),
    };

    await module.finConfirmarBaixa.call(context);
    expect(apiPost).not.toHaveBeenCalled();
    expect(context.finBaixaModal.error).toContain('maior que zero');

    context.finBaixaModal.amount = '121.55';
    await module.finConfirmarBaixa.call(context);

    expect(apiPost).toHaveBeenCalledOnce();
    expect(context.finBaixaModal.open).toBe(false);
  });

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

  it.each([
    ['retail_sale', 'accounts_receivable'],
    ['central_obligation', 'accounts_payable'],
  ])('envia somente obligation_id para %s', async (settlementMode, accountCode) => {
    const { module } = loadModule();
    const apiPost = vi.fn().mockResolvedValue({ settled: true });
    const context = {
      ...module,
      adminUser: { role: 'owner' },
      finQuitando: false,
      finBaixaModal: {
        open: true,
        item: {
          id: 'ledger-item-1',
          tipo: 'despesa',
          valor: 120,
          settlement_mode: settlementMode,
          obligation_id: '11111111-1111-4111-8111-111111111111',
          account_code: accountCode,
        },
        direction: 'payable',
        amount: '120,00',
        payment_date: '2026-07-27',
        payment_method: 'pix',
        cash_account: 'Caixa principal',
        note: '',
        error: null,
      },
      apiPost,
      loadFinanceiro: vi.fn(),
      loadSino: vi.fn(),
      loadFinExtrato: vi.fn(),
      $nextTick: vi.fn(),
    };

    await module.finConfirmarBaixa.call(context);

    const payload = apiPost.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload.obligation_id).toBe('11111111-1111-4111-8111-111111111111');
    expect(payload).not.toHaveProperty('account_code');
  });

  it('envia marketing_payable somente para a conta central de Marketing', async () => {
    const { module } = loadModule();
    const apiPost = vi.fn().mockResolvedValue({ settled: true });
    const context = {
      ...module,
      adminUser: { role: 'owner' },
      finQuitando: false,
      finBaixaModal: {
        open: true,
        item: {
          id: 'marketing_payable',
          tipo: 'marketing',
          valor: 120,
          settlement_mode: 'central_account',
          account_code: 'marketing_payable',
        },
        direction: 'payable',
        amount: '120,00',
        payment_date: '2026-07-27',
        payment_method: 'pix',
        cash_account: 'Caixa principal',
        note: '',
        error: null,
      },
      apiPost,
      loadFinanceiro: vi.fn(),
      loadSino: vi.fn(),
      loadFinExtrato: vi.fn(),
      $nextTick: vi.fn(),
    };

    await module.finConfirmarBaixa.call(context);

    const payload = apiPost.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload.account_code).toBe('marketing_payable');
    expect(payload).not.toHaveProperty('obligation_id');
  });
});

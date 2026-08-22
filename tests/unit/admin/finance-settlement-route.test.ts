import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

const payment = {
  target_id: 'item-1',
  amount: 10,
  paid_at: '2026-07-27T15:00:00.000Z',
  payment_method: 'pix',
  cash_account: 'Caixa principal',
  idempotency_key: 'finance-route-test-key',
};

async function buildRoute() {
  vi.resetModules();
  const settleMatrizLedgerOpenItem = vi.fn().mockResolvedValue({
    transaction_id: 'transaction-1',
  });

  vi.doMock('../../../src/admin/auth.js', () => ({
    requireAdminAuth: async () => undefined,
    requireAdminOwner: async () => undefined,
  }));
  vi.doMock('../../../src/shared/config/env.js', () => ({
    env: {
      FAREJADOR_ENV: 'test',
      MATRIZ_CENTRAL_LEDGER: true,
      MATRIZ_CENTRAL_LEDGER_READ: true,
    },
  }));
  vi.doMock('../../../src/shared/logger.js', () => ({
    logger: { error: vi.fn() },
  }));
  vi.doMock('../../../src/admin/painel/matriz-ledger-settlement.js', () => ({
    settleMatrizLedgerOpenItem,
  }));
  vi.doMock('../../../src/admin/painel/matriz-ledger-statement.js', () => ({
    getMatrizLedgerStatement: vi.fn(),
  }));
  vi.doMock('../../../src/admin/painel/matriz-ledger-writeoff.js', () => ({
    writeOffMatrizCredit: vi.fn(),
  }));
  vi.doMock('../../../src/admin/painel/queries-financeiro-integridade.js', () => ({
    settleMatrizExpense: vi.fn(),
    settleWholesaleOrderPayment: vi.fn(),
    settleWholesalePurchasePayment: vi.fn(),
  }));
  vi.doMock('../../../src/admin/painel/queries-comissoes-acoes.js', () => ({
    settleCommissionEntries: vi.fn(),
  }));
  vi.doMock('../../../src/admin/painel/queries-comissoes-estornos.js', () => ({
    settleCommissionRefund: vi.fn(),
  }));
  vi.doMock('../../../src/admin/painel/queries-mensalidades.js', () => ({
    settleMatrizPartnerMonthlyFee: vi.fn(),
  }));
  vi.doMock('../../../src/admin/painel/route-helpers.js', () => ({
    mapWriteError: () => ({ status: 500, error: 'internal_server_error' }),
    operatorLabel: () => 'owner:test',
  }));

  const { registerPainelFinanceiroLedger } = await import(
    '../../../src/admin/painel/route-financeiro-ledger.js'
  );
  const app = Fastify();
  await registerPainelFinanceiroLedger(app);
  return { app, settleMatrizLedgerOpenItem };
}

describe('contrato da porta unica de baixa financeira', () => {
  it.each([
    ['retail_sale', 'accounts_receivable'],
    ['wholesale_sale', 'accounts_receivable'],
    ['wholesale_purchase', 'accounts_payable'],
    ['central_obligation', 'accounts_payable'],
  ])(
    'aceita %s enviado por um painel antigo e liquida pela obrigacao',
    async (settlementMode, accountCode) => {
      const { app, settleMatrizLedgerOpenItem } = await buildRoute();
      const response = await app.inject({
        method: 'POST',
        url: '/admin/api/matriz/financeiro/settle',
        payload: {
          ...payment,
          settlement_mode: settlementMode,
          obligation_id: '11111111-1111-4111-8111-111111111111',
          account_code: accountCode,
        },
      });

      expect(response.statusCode).toBe(200);
      const target = settleMatrizLedgerOpenItem.mock.calls[0]?.[0] as
        Record<string, unknown>;
      expect(target.obligation_id).toBe('11111111-1111-4111-8111-111111111111');
      expect(target).not.toHaveProperty('account_code');
      await app.close();
    },
  );

  it('aceita marketing_payable como conta central', async () => {
    const { app, settleMatrizLedgerOpenItem } = await buildRoute();
    const response = await app.inject({
      method: 'POST',
      url: '/admin/api/matriz/financeiro/settle',
      payload: {
        ...payment,
        settlement_mode: 'central_account',
        account_code: 'marketing_payable',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(settleMatrizLedgerOpenItem).toHaveBeenCalledWith(
      expect.objectContaining({ account_code: 'marketing_payable' }),
    );
    await app.close();
  });

  it('recusa outra conta quando o alvo e uma conta central', async () => {
    const { app, settleMatrizLedgerOpenItem } = await buildRoute();
    const response = await app.inject({
      method: 'POST',
      url: '/admin/api/matriz/financeiro/settle',
      payload: {
        ...payment,
        settlement_mode: 'central_account',
        account_code: 'accounts_payable',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'settlement_target_invalid' });
    expect(settleMatrizLedgerOpenItem).not.toHaveBeenCalled();
    await app.close();
  });
});

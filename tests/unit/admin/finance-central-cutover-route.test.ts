import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

async function buildFinanceRoute(reason: 'disabled' | 'integration_red') {
  vi.resetModules();
  vi.doMock('../../../src/persistence/db.js', () => ({ pool: {} }));
  vi.doMock('../../../src/shared/config/env.js', () => ({
    env: {
      FAREJADOR_ENV: 'test',
      NETWORK_COMMISSION_LEDGER: false,
      MATRIZ_EXPENSES: false,
      MATRIZ_CENTRAL_LEDGER: true,
      MATRIZ_CENTRAL_LEDGER_READ: true,
    },
  }));
  const logger = { error: vi.fn(), warn: vi.fn() };
  vi.doMock('../../../src/shared/logger.js', () => ({ logger }));
  vi.doMock('../../../src/admin/auth.js', () => ({
    requireAdminAuth: async () => undefined,
    requireAdminOwner: async () => undefined,
  }));
  vi.doMock('../../../src/admin/painel/route-helpers.js', () => ({
    dashboardPayload: () => ({}),
    mapWriteError: () => ({ status: 500, error: 'internal_server_error' }),
    operatorLabel: () => 'owner:test',
  }));
  vi.doMock('../../../src/admin/painel/route-financeiro-ledger.js', () => ({
    registerPainelFinanceiroLedger: async () => undefined,
  }));

  const { MatrizCentralLedgerUnavailableError } = await import(
    '../../../src/admin/painel/queries-financeiro-read-switch.js'
  );
  const getMatrizFinanceiroVisao = vi.fn().mockRejectedValue(
    new MatrizCentralLedgerUnavailableError(reason),
  );
  vi.doMock('../../../src/admin/painel/queries.js', () => ({
    archiveMatrizExpenseCategory: vi.fn(),
    createMatrizExpense: vi.fn(),
    createMatrizExpenseCategory: vi.fn(),
    getMatrizExpenses: vi.fn(),
    getMatrizFinanceiroVisao,
    listMatrizExpenseCategories: vi.fn(),
    removeMatrizExpense: vi.fn(),
    settleMatrizExpense: vi.fn(),
    sweepCommissionEntries: vi.fn(),
  }));

  const { registerPainelFinanceiro } = await import(
    '../../../src/admin/painel/route-financeiro.js'
  );
  const app = Fastify();
  await registerPainelFinanceiro(app);
  return { app, getMatrizFinanceiroVisao, logger };
}

describe('corte central na rota do Financeiro', () => {
  it('recusa mês inválido antes de consultar o livro', async () => {
    const { app, getMatrizFinanceiroVisao } = await buildFinanceRoute('disabled');
    const response = await app.inject({
      method: 'GET', url: '/admin/api/matriz/financeiro?mes=2026-13',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_month' });
    expect(getMatrizFinanceiroVisao).not.toHaveBeenCalled();
    await app.close();
  });

  it.each(['disabled', 'integration_red'] as const)(
    'retorna 503 quando o livro central esta %s e nao mascara com legado',
    async (reason) => {
      const { app, getMatrizFinanceiroVisao, logger } =
        await buildFinanceRoute(reason);
      const response = await app.inject({
        method: 'GET',
        url: '/admin/api/matriz/financeiro',
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        error: 'central_ledger_unavailable',
        reason,
      });
      expect(getMatrizFinanceiroVisao).toHaveBeenCalledOnce();
      expect(logger.error).toHaveBeenCalledWith(
        { reason },
        expect.stringContaining('legado nao sera usado'),
      );
      await app.close();
    },
  );
});

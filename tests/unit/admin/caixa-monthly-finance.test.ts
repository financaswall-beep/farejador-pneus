import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ read: vi.fn(), agenda: vi.fn(), overview: vi.fn(), inventory: vi.fn() }));
vi.mock('../../../src/shared/config/env.js', () => ({ env: { FAREJADOR_ENV: 'test' } }));
vi.mock('../../../src/persistence/db.js', () => ({ pool: {} }));
vi.mock('../../../src/admin/painel/queries-financeiro-read-switch.js', () => ({ getMatrizFinancialRead: mocks.read }));
vi.mock('../../../src/admin/painel/matriz-ledger-open-items.js', () => ({ getMatrizLedgerOpenItems: mocks.agenda }));
vi.mock('../../../src/admin/painel/matriz-finance-overview.js', () => ({ getMatrizFinanceOverview: mocks.overview }));
vi.mock('../../../src/admin/painel/matriz-stock-capital.js', () => ({ getMatrizStockCapital: mocks.inventory }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { warn: vi.fn() } }));
import { getMatrizMonthlyFinance } from '../../../src/admin/caixa/monthly-finance.js';
import { simpleFinanceQuerySchema } from '../../../src/admin/caixa/finance-query.js';

describe('apuração mensal compartilhada entre app e web', () => {
  const pool = {} as Pool;
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.useRealTimers());

  it.each(['confirmado', 'custo_pendente', 'divergente'])('preserva o resultado e a situação %s do web', async status => {
    const truth = { competencia: { lucro_confirmado: '-20.00', status }, caixa: { saldo_atual: '1040.00' } };
    const agenda = { a_receber: { total: '50.00' }, a_pagar: { total: '80.00' } };
    const expenses = [{ account: 'marketing_expense', label: 'Marketing', amount: '30.00' }];
    mocks.read.mockResolvedValue({ source: 'central_ledger', integration_status: 'yellow', truth });
    mocks.agenda.mockResolvedValue(agenda);
    mocks.overview.mockResolvedValue({ expenses });
    const inventory = { capital: '43.50', pneus: 4, sem_custo: 0 };
    mocks.inventory.mockResolvedValue(inventory);
    const actual = await getMatrizMonthlyFinance('2026-08', pool);
    expect(actual).toEqual({ period: '2026-08', source: 'central_ledger', integration_status: 'yellow', truth, agenda, expenses, inventory });
    expect(actual.truth).toBe(truth);
    expect(mocks.read).toHaveBeenCalledWith('test', pool, '2026-08');
    expect(mocks.overview).toHaveBeenCalledWith('2026-08', 'test', pool);
    expect(mocks.agenda).toHaveBeenCalledWith('test', pool);
    expect(mocks.inventory).toHaveBeenCalledWith('test', pool);
  });

  it('mantém os valores financeiros quando apenas o estoque fica indisponível', async () => {
    mocks.read.mockResolvedValue({ source: 'central_ledger', truth: { caixa: { saldo_atual: '47.50' } } });
    mocks.agenda.mockResolvedValue({}); mocks.overview.mockResolvedValue({ expenses: [] });
    mocks.inventory.mockRejectedValue(new Error('stock_unavailable'));
    const actual = await getMatrizMonthlyFinance('2026-08', pool);
    expect(actual.inventory).toBeNull();
    expect(actual.truth.caixa.saldo_atual).toBe('47.50');
  });

  it('não substitui indisponibilidade por zeros ou por cálculo antigo', async () => {
    mocks.read.mockRejectedValue(new Error('central_ledger_integration_red'));
    await expect(getMatrizMonthlyFinance('2026-08', pool)).rejects.toThrow('central_ledger_integration_red');
    expect(mocks.agenda).not.toHaveBeenCalled();
    expect(mocks.overview).not.toHaveBeenCalled();
  });

  it('valida mês-calendário e preserva clientes que usam range', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-01T02:30:00Z'));
    expect(simpleFinanceQuerySchema.parse({ range: '7d' })).toEqual({ range: '7d' });
    expect(simpleFinanceQuerySchema.parse({ period: '2026-08' })).toEqual({ range: '30d', period: '2026-08' });
    for (const period of ['2026-09', '2026-00', '2026-13', '2026-1', '', '2026-08-01']) {
      expect(simpleFinanceQuerySchema.safeParse({ period }).success).toBe(false);
    }
    vi.setSystemTime(new Date('2026-09-01T03:00:00Z'));
    expect(simpleFinanceQuerySchema.safeParse({ period: '2026-09' }).success).toBe(true);
  });
});

import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ report: vi.fn() }));
vi.mock('../../../src/admin/painel/queries-financial-report.js', () => ({ getFinancialReport: mock.report }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { error: vi.fn() } }));
import { financeStatementQuery, getMatrizFinanceStatement } from '../../../src/admin/caixa/finance-statement.js';
import { registerCaixaFinanceStatementRoutes } from '../../../src/admin/caixa/route-finance-statement.js';
import { FinancialReportLimitError } from '../../../src/admin/painel/financial-report-filter.js';

describe('extrato do app reutiliza o relatório financeiro', () => {
  beforeEach(() => vi.resetAllMocks());
  it('preserva os saldos mensais do motor ao paginar e buscar, sem somar só a página', async () => {
    const rows = Array.from({ length: 240 }, (_, id) => ({ id: String(id), cash_out: 9.5, cash_in: 0 }));
    mock.report.mockResolvedValue({ as_of: '2026-08-31T12:00:00Z', integration_status: 'green',
      summary: { opening: 2500, closing: 4700, incoming: 5000, outgoing: 2800 },
      cash_filtered: { incoming: 0, outgoing: 2280 }, cash_rows: rows });
    const result = await getMatrizFinanceStatement(financeStatementQuery.parse({
      period: '2026-08', search: 'Fornecedor', direction: 'out', offset: 200, limit: 25,
    }));
    expect(mock.report).toHaveBeenCalledWith(expect.objectContaining({
      from: '2026-08-01', to: '2026-08-31', search: 'Fornecedor', direction: 'out', view: 'cash',
    }));
    expect(result.total).toBe(240); expect(result.rows).toEqual(rows.slice(200, 225));
    expect(result.summary).toEqual({ opening: 2500, closing: 4700, incoming: 5000, outgoing: 2800 });
    expect(result.filtered.outgoing).toBe(2280);
  });
  it('preserva estornos e limites explícitos, inclusive no fevereiro bissexto', async () => {
    const reversal = { id: 'reversal', reversal_of: 'payment', cash_in: 50, cash_out: 0 };
    mock.report.mockResolvedValue({ summary: {}, cash_rows: [reversal], cash_filtered: {} });
    expect((await getMatrizFinanceStatement(financeStatementQuery.parse({ period: '2024-02' }))).rows).toEqual([reversal]);
    expect(mock.report.mock.calls[0]?.[0].to).toBe('2024-02-29');
    mock.report.mockRejectedValue(new FinancialReportLimitError('too_many_rows'));
    await expect(getMatrizFinanceStatement(financeStatementQuery.parse({ period: '2024-02' }))).rejects.toThrow(FinancialReportLimitError);
  });
  it('valida filtros e não aceita mês futuro, limite inválido ou ambiente fornecido pelo cliente', () => {
    for (const input of [{ period: '2199-01' }, { period: '2026-13' }, { period: '2024-02', limit: 101 },
      { period: '2024-02', offset: -1 }, { period: '2024-02', environment: 'prod' }, { period: '2024-02', direction: 'sql' }]) {
      expect(financeStatementQuery.safeParse(input).success).toBe(false);
    }
  });
  it('limita o mês em andamento a hoje em São Paulo, mesmo após a meia-noite UTC', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-19T01:00:00Z'));
    mock.report.mockResolvedValue({ summary: {}, cash_rows: [], cash_filtered: {} });
    try {
      await getMatrizFinanceStatement(financeStatementQuery.parse({ period: '2026-09' }));
      expect(mock.report).toHaveBeenCalledWith(expect.objectContaining({ from: '2026-09-01', to: '2026-09-18' }));
    } finally { vi.useRealTimers(); }
  });
  it('protege a rota pela sessão e pela permissão financeira antes de ler os dados', async () => {
    const app = Fastify();
    registerCaixaFinanceStatementRoutes(app, async () => {},
      async (req, reply) => { if (!req.headers.authorization) await reply.code(401).send({ error: 'unauthorized' }); },
      async (req, reply) => { if (req.headers.authorization !== 'Bearer finance') await reply.code(403).send({ error: 'forbidden' }); });
    try {
      expect((await app.inject('/api/caixa/financeiro-extrato?period=2024-02')).statusCode).toBe(401);
      expect((await app.inject({ url: '/api/caixa/financeiro-extrato?period=2024-02', headers: { authorization: 'Bearer seller' } })).statusCode).toBe(403);
      expect(mock.report).not.toHaveBeenCalled();
      mock.report.mockRejectedValue(new Error('central_ledger_integration_red'));
      const failed = await app.inject({ url: '/api/caixa/financeiro-extrato?period=2024-02', headers: { authorization: 'Bearer finance' } });
      expect(failed.statusCode).toBe(503); expect(failed.json()).toEqual({ error: 'finance_statement_unavailable' });
    } finally { await app.close(); }
  });
});

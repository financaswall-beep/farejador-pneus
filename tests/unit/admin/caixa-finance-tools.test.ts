import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ create: vi.fn(), categories: vi.fn(), report: vi.fn(), expenses: true }));
vi.mock('../../../src/shared/config/env.js', () => ({ env: { FAREJADOR_ENV: 'test', get MATRIZ_EXPENSES() { return m.expenses; } } }));
vi.mock('../../../src/persistence/db.js', () => ({ pool: {} }));
vi.mock('../../../src/admin/painel/queries-financeiro-despesas-integridade.js', () => ({ createMatrizExpense: m.create }));
vi.mock('../../../src/admin/painel/queries-despesas-categorias.js', () => ({ listMatrizExpenseCategories: m.categories }));
vi.mock('../../../src/admin/painel/queries-financial-report.js', () => ({ getFinancialReport: m.report }));
import { registerCaixaFinanceExpenseRoutes } from '../../../src/admin/caixa/route-finance-expenses.js';
import { registerCaixaFinanceReportRoutes } from '../../../src/admin/caixa/route-finance-reports.js';
import { FinancialReportLimitError } from '../../../src/admin/painel/financial-report-filter.js';
import { MatrizCentralLedgerUnavailableError } from '../../../src/admin/painel/queries-financeiro-read-switch.js';

const expense = { category: 'aluguel', amount: 750.5, description: 'Aluguel', payment_status: 'paid',
  occurred_at: '2026-01-20T15:00:00Z', paid_at: '2026-01-22T15:00:00Z', document_date: '2026-01-20', competence_month: '2026-01-01', idempotency_key: 'expense-app-fixture-1' };
const reportQuery = '?from=2026-01-01&to=2026-01-22&view=cash&origin=compras&direction=out&search=Fornecedor';
function appFor(role = 'owner', authenticated = true, allowed = true) {
  const app = Fastify();
  const flag = async () => {};
  const auth = async (req: any, reply: any) => {
    if (!authenticated) { await reply.code(401).send({ error: 'unauthorized' }); return; }
    req.caixa = { panelRole: role, displayName: 'Responsável', username: 'dono' };
  };
  const finance = async (_: any, reply: any) => { if (!allowed) await reply.code(403).send({ error: 'forbidden' }); };
  registerCaixaFinanceExpenseRoutes(app, flag, auth, finance); registerCaixaFinanceReportRoutes(app, flag, auth, finance);
  return app;
}
describe('despesas e relatórios do app compartilham o financeiro web', () => {
  beforeEach(() => {
    vi.clearAllMocks(); m.expenses = true;
    m.create.mockResolvedValue({ id: 'expense-1', amount: '750.50' });
    m.categories.mockResolvedValue([{ id: 'aluguel', label: 'Aluguel', archived: false }, { id: 'antiga', label: 'Antiga', archived: true }]);
    m.report.mockResolvedValue({ marker: 'shared-ledger-report' });
  });
  it('usa a mesma transação de despesa, com datas distintas, centavos, ator confiável e chave original', async () => {
    const app = appFor();
    try {
      const response = await app.inject({ method: 'POST', url: '/api/caixa/financeiro-despesas', payload: { ...expense, environment: 'prod', created_by: 'falso' } });
      expect(response.statusCode).toBe(201); expect(response.json()).toEqual({ created: true, expense: { id: 'expense-1', amount: '750.50' } });
      expect(m.create).toHaveBeenCalledWith({ ...expense, created_by: 'Responsável (dono)' });
      await app.inject({ method: 'POST', url: '/api/caixa/financeiro-despesas', payload: expense });
      expect(m.create.mock.calls[1]).toEqual(m.create.mock.calls[0]);
    } finally { await app.close(); }
  });
  it('encaminha despesa a pagar sem data de pagamento e só oferece categorias ativas', async () => {
    const app = appFor();
    try {
      const pending = { ...expense, paid_at: undefined, payment_status: 'pending', due_date: '2026-02-10' };
      expect((await app.inject({ method: 'POST', url: '/api/caixa/financeiro-despesas', payload: pending })).statusCode).toBe(201);
      expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ payment_status: 'pending', due_date: '2026-02-10' }));
      expect(m.create.mock.calls[0]?.[0]).not.toHaveProperty('paid_at');
      const response = await app.inject('/api/caixa/financeiro-despesas/categorias');
      expect(response.json().categories).toEqual([{ id: 'aluguel', label: 'Aluguel', archived: false }]); expect(response.headers['cache-control']).toBe('no-store');
    } finally { await app.close(); }
  });
  it.each([{ amount: 1.005 }, { amount: 0 }, { amount: -2 }, { payment_status: 'pending', due_date: undefined },
    { due_date: '2026-02-30' }, { document_date: '2026-02-30' }, { competence_month: '2026-13-01' },
    { occurred_at: '2199-01-01T15:00:00Z' }, { paid_at: '2199-01-01T15:00:00Z' }, { idempotency_key: '' }])('recusa valores e datas inválidos antes da escrita: %j', async changes => {
    const app = appFor(); try {
      const response = await app.inject({ method: 'POST', url: '/api/caixa/financeiro-despesas', payload: { ...expense, ...changes } });
      expect(response.statusCode).toBe(400); expect(m.create).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it.each([['admin', true, true, 403], ['owner', false, true, 401], ['owner', true, false, 403]] as const)('despesas: protege papel=%s sessão=%s módulo=%s', async (role, authenticated, allowed, status) => {
    const app = appFor(role, authenticated, allowed); try {
      expect((await app.inject({ method: 'POST', url: '/api/caixa/financeiro-despesas', payload: expense })).statusCode).toBe(status);
      expect((await app.inject('/api/caixa/financeiro-despesas/categorias')).statusCode).toBe(status);
      expect(m.create).not.toHaveBeenCalled(); expect(m.categories).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('respeita a flag de despesas e preserva conflitos de idempotência', async () => {
    const app = appFor(); try {
      m.expenses = false;
      expect((await app.inject({ method: 'POST', url: '/api/caixa/financeiro-despesas', payload: expense })).statusCode).toBe(404); expect(m.create).not.toHaveBeenCalled();
      m.expenses = true; m.create.mockRejectedValue(new Error('idempotency_conflict'));
      const conflict = await app.inject({ method: 'POST', url: '/api/caixa/financeiro-despesas', payload: expense });
      expect(conflict.statusCode).toBe(409); expect(conflict.json()).toEqual({ error: 'idempotency_conflict' });
    } finally { await app.close(); }
  });
  it('consulta e impressão passam os mesmos filtros ao relatório web, sem recalcular ou substituir valores', async () => {
    const app = appFor('admin'); try {
      for (const suffix of ['', '/imprimir']) {
        const response = await app.inject('/api/caixa/financeiro-relatorios' + suffix + reportQuery);
        expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ marker: 'shared-ledger-report' }); expect(response.headers['cache-control']).toBe('no-store');
      }
      expect(m.report.mock.calls[0]).toEqual(m.report.mock.calls[1]);
      expect(m.report).toHaveBeenCalledWith(expect.objectContaining({ from: '2026-01-01', to: '2026-01-22', view: 'cash', origin: 'compras', direction: 'out', search: 'Fornecedor' }));
    } finally { await app.close(); }
  });
  it.each([['', false, true, 401], ['', true, false, 403]] as const)('bloqueia todos os relatórios sem sessão ou módulo', async (_, authenticated, allowed, status) => {
    const app = appFor('admin', authenticated, allowed); try {
      for (const suffix of ['', '/exportar', '/imprimir']) expect((await app.inject('/api/caixa/financeiro-relatorios' + suffix + reportQuery)).statusCode).toBe(status);
      expect(m.report).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('exporta CSV pelo formatador compartilhado, incluindo estorno e proteção contra fórmulas', async () => {
    const app = appFor(); try {
      m.report.mockResolvedValue({ filters: { view: 'cash', flow: 'realized' }, cash_rows: [{ cash_on: '2026-01-02', description: '=1+1', origin: 'compras',
        source_id: 'purchase', reference: 'Compra', party: 'Fornecedor', cash_in: 0, cash_out: 80.25, payment_method: 'pix', cash_account: 'Caixa', reversal_of: 'old-payment', reversed: false }] });
      const response = await app.inject('/api/caixa/financeiro-relatorios/exportar' + reportQuery);
      expect(response.statusCode).toBe(200); expect(response.headers['content-type']).toContain('text/csv');
      expect(response.body).toContain('80,25'); expect(response.body).toContain("'=1+1"); expect(response.body).toContain('Sim');
      expect(response.headers['content-disposition']).toContain('financeiro-cash-2026-01-01-2026-01-22.csv');
    } finally { await app.close(); }
  });
  it.each(['&environment=prod', '&to=2199-01-01', '&view=sql', '&from=2026-02-30'])('recusa filtros inválidos %s', async extra => {
    const app = appFor(); try {
      expect((await app.inject('/api/caixa/financeiro-relatorios' + reportQuery + extra)).statusCode).toBe(400); expect(m.report).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('não converte indisponibilidade nem excesso de registros em relatório vazio', async () => {
    const app = appFor(); try {
      for (const [error, code] of [[new FinancialReportLimitError(), 422], [new MatrizCentralLedgerUnavailableError('integration_red'), 409], [new Error('database_failed'), 503]] as const) {
        m.report.mockRejectedValue(error); const response = await app.inject('/api/caixa/financeiro-relatorios' + reportQuery);
        expect(response.statusCode).toBe(code); expect(response.json()).not.toHaveProperty('summary');
      }
    } finally { await app.close(); }
  });
});

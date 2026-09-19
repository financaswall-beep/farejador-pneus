import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { management } = vi.hoisted(() => ({ management: vi.fn() }));
vi.mock('../../../src/admin/painel/queries-colaboradores-gestao.js', () => ({ getMatrizCollaboratorManagement: management }));
vi.mock('../../../src/shared/config/env.js', () => ({ env: { FAREJADOR_ENV: 'test' } }));
vi.mock('../../../src/persistence/db.js', () => ({ pool: {} }));
import { getFinanceCommissionMonth, getFinanceCommissionMonthDetail } from '../../../src/admin/caixa/finance-commission-month.js';
const person = { id: 'person-1', display_name: 'João', job_title: 'Vendedor', active: true,
  commission_active: true, commission_amount: 100, commission_settlement_frequency: 'monthly',
  revenue: 2000, margin: 1000, sales_count: 20, commission_kind: 'percent', commission_basis: 'revenue', commission_value: 5 };
const settlement = { id: 'closed-1', collaborator_id: 'person-1', name: 'João', frequency: 'monthly',
  period_start: '2026-08-01', period_end: '2026-08-31', commission_amount: '100.00', payment_total: '2100.00', status: 'pending' };
function database(rows = [settlement]) {
  return { query: vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes('FROM finance.matriz_payroll_items')) return { rows };
    if (sql.includes('count(*) OVER()')) return { rows: [{ id: 'sale-1', reference: 'Venda', occurred_at: '2026-08-11', commission_amount: '8', total: 120 }] };
    return { rows: [{ collaborator_id: 'person-1', commission_amount: '999.99', gross_sales: '1000', sales_count: 5 }] };
  }) };
}
describe('competência e fechamentos de comissões no app', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-19T01:30:00Z')); management.mockResolvedValue({ collaborators: [person] }); });
  afterEach(() => vi.useRealTimers());
  it('preserva comissão congelada do web e separa salário do valor da comissão', async () => {
    const db = database(); const data = await getFinanceCommissionMonth('2026-08', db as never);
    expect(data.summary).toEqual({ accrued: 100, paid: 0, payable: 100, payment_total: 2100 });
    expect(management).toHaveBeenCalledWith('2026-08-01', 'test', db);
    expect(db.query.mock.calls.find(([sql]) => sql.includes('FROM finance.matriz_payroll_items'))?.[1]).toEqual(['test', '2026-08-01', '2026-09-01']);
  });
  it('pagas usa os fechamentos pagos da competência, não todo o histórico', async () => {
    const data = await getFinanceCommissionMonth('2026-08', database([{ ...settlement, status: 'paid' }]) as never);
    expect(data.summary).toMatchObject({ paid: 100, payable: 0, payment_total: 0 });
  });
  it('usa o fuso de São Paulo na apuração do mês atual', async () => {
    const db = database(); await getFinanceCommissionMonth('2026-09', db as never);
    expect(db.query.mock.calls.find(([sql]) => !sql.includes('FROM finance.matriz_payroll_items'))?.[1]).toEqual(['test', '2026-09-01', '2026-09-19']);
  });
  it('mantém a apuração semanal do motor de regras compartilhado', async () => {
    management.mockResolvedValue({ collaborators: [{ ...person, commission_settlement_frequency: 'weekly' }] });
    const data = await getFinanceCommissionMonth('2026-08', database() as never);
    expect(data.collaborators[0]?.commission_amount).toBe(999.99);
  });
  it('recusa fechamento de outro colaborador ou fora do mês selecionado', async () => {
    expect(await getFinanceCommissionMonthDetail('2026-08', 'person-1', 'other-target', 0, database() as never)).toBeNull();
    expect(await getFinanceCommissionMonthDetail('2026-08', 'person-2', 'closed-1', 0, database() as never)).toBeNull();
  });
  it('detalhes usam o intervalo do fechamento escolhido com paginação explícita', async () => {
    const db = database(); const data = await getFinanceCommissionMonthDetail('2026-08', 'person-1', 'closed-1', 50, db as never);
    expect(data?.total).toBe(120); expect(data?.settlement?.payment_total).toBe('2100.00');
    expect(db.query.mock.calls.find(([sql]) => sql.includes('count(*) OVER()'))?.[1]).toEqual(['test', '2026-08-01', '2026-09-01', 'person-1', 50]);
  });
});

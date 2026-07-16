import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool } from 'pg';

let getManagement: typeof import('../../../src/admin/painel/queries-colaboradores-gestao.js').getMatrizCollaboratorManagement;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test', FAREJADOR_ENV: 'prod', DATABASE_URL: 'postgres://test',
    CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'emergency-token',
  });
  ({ getMatrizCollaboratorManagement: getManagement } = await import('../../../src/admin/painel/queries-colaboradores-gestao.js'));
});

describe('gestão de colaboradores da matriz', () => {
  it('bloqueia a tela com erro controlado enquanto a migration ainda nao terminou', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ready: false }] });
    await expect(getManagement('2026-07-01', 'prod', { query } as unknown as Pool))
      .rejects.toThrow('collaborator_management_unavailable');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('aceita cargos dinâmicos e calcula prévia sem misturar competência com caixa', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("to_regclass('finance.matriz_payroll_items')")) return { rows: [{ ready: true }] };
      if (sql.includes('FROM network.matriz_collaborators mc')) return { rows: [
        { id: 'c1', display_name: 'João', username: 'joao', job: 'vendedor', job_title: 'Consultor', work_area: 'sales', panel_role: null, active: true,
          employment_type: 'clt', base_salary: '2200', monthly_base_salary: '2200', payment_day: 5, payment_method: 'pix', payment_note: null, compensation_starts_on: '2026-07-01',
          commission_kind: 'percent', commission_basis: 'margin', commission_value: '2', commission_starts_on: '2026-07-01', commission_active: true },
        { id: 'c2', display_name: 'Ana', username: 'ana', job: 'colaborador', job_title: 'Secretária', work_area: 'administrative', panel_role: 'admin', active: true,
          employment_type: 'clt', base_salary: '2100', monthly_base_salary: '2100', payment_day: 5, payment_method: 'transferencia', payment_note: null, compensation_starts_on: '2026-07-01',
          commission_kind: null, commission_basis: null, commission_value: '0', commission_starts_on: null, commission_active: false },
      ] };
      if (sql.includes('WITH retail AS')) return { rows: [{ id: 'c1', sales_count: 10, revenue: '12000', margin: '5000', items_without_cost: 0, commission_amount: '100', deliveries_count: 0, trips_count: 0, distance_km: 0, on_time_pct: null }] };
      if (sql.includes('matriz_payroll_adjustments')) return { rows: [{ collaborator_id: 'c1', additions: '300', deductions: '120' }] };
      if (sql.includes('matriz_payroll_periods p')) return { rows: [] };
      throw new Error(`consulta inesperada: ${sql.slice(0, 40)}`);
    });
    const result = await getManagement('2026-07-01', 'prod', { query } as unknown as Pool);
    const joao = result.collaborators.find((c) => c.id === 'c1')!;
    expect(joao.commission_amount).toBe(100);
    expect(joao.total_due).toBe(2480);
    expect(joao.payroll_status).toBe('preview');
    expect(result.summary.role_count).toBe(2);
    expect(result.summary.payroll_payable).toBe(0);
  });

  it('mantém equipe neutra e concilia folha com Financeiro na interface e migration', () => {
    const html = readFileSync(resolve('painel/public/index.html'), 'utf8');
    const tela = html.split('TELA: COLABORADORES')[1]!.split('TELA: BOT')[0]!;
    const migration = readFileSync(resolve('db/migrations/0133_matriz_collaborator_management.sql'), 'utf8');
    expect(tela).toContain('Cargos cadastrados');
    expect(tela).toContain("{id:'remuneracao',label:'Remuneração'}");
    expect(html).toContain('Folha de pagamento');
    expect(tela).not.toContain('<p class="text-xs text-gray-500">Vendedores</p>');
    expect(migration).toContain('sync_matriz_payroll_payment');
    expect(migration).toContain('protect_matriz_payroll_expense');
    expect(migration).toContain("job IN ('vendedor', 'entregador', 'colaborador')");
    expect(migration).not.toMatch(/GRANT\s+.+matriz_payroll/i);
  });
});

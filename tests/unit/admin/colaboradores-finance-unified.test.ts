import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
  compensation: vi.fn(), commission: vi.fn(),
}));

vi.mock('../../../src/persistence/db.js', () => ({ pool: {} }));
vi.mock('../../../src/admin/painel/queries-colaboradores-config.js', () => ({
  saveMatrizCollaboratorCompensation: dependencies.compensation,
}));
vi.mock('../../../src/admin/caixa/operation-team.js', () => ({
  saveMatrizOperationCommissionRule: dependencies.commission,
}));

import { saveMatrizFinancialConfiguration } from '../../../src/admin/painel/matriz-financial-configuration.js';

function frontendModule() {
  const file = 'painel/public/app.colaboradores.finance.js';
  const sandbox: Record<string, any> = { window: {} };
  runInNewContext(readFileSync(resolve(file), 'utf8'), sandbox, { filename: file });
  return sandbox.window.PAINEL_MODULES.colaboradoresFinance();
}

describe('remuneração e comissões unificadas', () => {
  beforeEach(() => vi.clearAllMocks());

  it('projeta salários semanais no mês sem incluir inativos', () => {
    const app: any = {
      colabAtivos: [
        { monthly_base_salary: 1_200, salary_frequency: 'monthly' },
        { monthly_base_salary: 300, salary_frequency: 'weekly' },
      ],
    };
    Object.defineProperties(app, Object.getOwnPropertyDescriptors(frontendModule()));

    expect(app.colabMonthlySalaryTotal).toBe(2_500);
  });

  it('salva as duas metades dentro da mesma transação', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const client = { query, release: vi.fn() };
    const pool = { connect: vi.fn().mockResolvedValue(client) } as any;
    dependencies.compensation.mockResolvedValue({ saved: true });
    dependencies.commission.mockResolvedValue({ active: true });

    await saveMatrizFinancialConfiguration(
      { collaborator_id: 'c1' } as any, { collaborator_id: 'c1' } as any, pool,
    );

    expect(query.mock.calls.map((call) => call[0])).toEqual(['BEGIN', 'COMMIT']);
    expect(dependencies.compensation).toHaveBeenCalledWith(expect.any(Object), client);
    expect(dependencies.commission).toHaveBeenCalledWith(expect.any(Object), client);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('desfaz salário quando a comissão falha', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const client = { query, release: vi.fn() };
    const pool = { connect: vi.fn().mockResolvedValue(client) } as any;
    dependencies.compensation.mockResolvedValue({ saved: true });
    dependencies.commission.mockRejectedValue(new Error('invalid_commission_basis'));

    await expect(saveMatrizFinancialConfiguration(
      { collaborator_id: 'c1' } as any, { collaborator_id: 'c1' } as any, pool,
    )).rejects.toThrow('invalid_commission_basis');

    expect(query.mock.calls.map((call) => call[0])).toEqual(['BEGIN', 'ROLLBACK']);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('publica a nova tela e mantém Folha separada', () => {
    const html = readFileSync(resolve('painel/public/index.html'), 'utf8');
    const routes = readFileSync(resolve('src/admin/painel/route-static.ts'), 'utf8');
    expect(html).toContain("{id:'remuneracao',label:'Remuneração e comissões'}");
    expect(html).toContain('colabSalvarConfiguracaoFinanceira()');
    expect(html).toContain("colabTab === 'folha'");
    expect(routes).toContain('app.colaboradores.finance.js');
  });

  it('mantém o editor compacto à direita na Matriz e no parceiro', () => {
    const html = readFileSync(resolve('painel/public/index.html'), 'utf8');
    const sideBySide = 'lg:grid-cols-[minmax(0,1fr)_minmax(320px,360px)]';
    expect(html.split(sideBySide)).toHaveLength(3);
    expect(html).toContain('partnerColaboradores.detail.compensation.employment_type');
    expect(html).toContain('colabRemForm.employment_type');
    expect(html.split('mt-2 grid grid-cols-4 gap-1.5').length).toBeGreaterThanOrEqual(4);
  });
});

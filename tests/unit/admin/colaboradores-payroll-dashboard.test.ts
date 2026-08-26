import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

function frontendModule() {
  const file = 'painel/public/app.colaboradores.payroll.js';
  const sandbox: Record<string, any> = { window: { PAINEL_MODULES: {} }, Intl, Date };
  runInNewContext(readFileSync(resolve(file), 'utf8'), sandbox, { filename: file });
  return sandbox.window.PAINEL_MODULES.colaboradoresPayroll();
}

function app(overrides: Record<string, unknown> = {}) {
  const target: any = {
    colaboradores: [], colabAdjustments: [], colabSummary: {}, colabMes: '2026-07',
    colabCurrentMonth: '2026-08', formatCurrency: (value: unknown) => `R$ ${Number(value).toFixed(2)}`,
    ...overrides,
  };
  Object.defineProperties(target, Object.getOwnPropertyDescriptors(frontendModule()));
  return target;
}

describe('painel processual da Folha da Matriz', () => {
  it('separa benefícios congelados dos ajustes manuais sem duplicar o total', () => {
    const page = app();
    const row = {
      benefits_total: 999,
      additions: 180,
      payroll_calculation: { recurring_benefits: [{ name: 'Ajuda', amount: 120 }] },
    };

    expect(page.colabFolhaBenefits(row)).toBe(120);
    expect(page.colabFolhaManualAdditions(row)).toBe(60);
    expect(page.colabFolhaAdjustmentLabel(row)).toBe('+ R$ 60.00');
  });

  it('só libera fechamento de mês terminado, com pessoas e sem bloqueadores', () => {
    const eligible = { active: true, employment_type: 'clt' };
    const page = app({ colaboradores: [eligible], colabSummary: {
      payroll_period_status: 'preview', payroll_review_count: 0,
    } });
    expect(page.colabFolhaPodeFechar).toBe(true);

    page.colabSummary.payroll_review_count = 1;
    expect(page.colabFolhaPodeFechar).toBe(false);
    page.colabSummary.payroll_review_count = 0;
    page.colabMes = '2026-08';
    expect(page.colabFolhaPodeFechar).toBe(false);
  });

  it('publica indicadores de processo, histórico e vínculo explícito com Financeiro', () => {
    const html = readFileSync(resolve('painel/public/index.html'), 'utf8');
    const query = [
      'src/admin/painel/queries-colaboradores-gestao.ts',
      'src/admin/painel/queries-colaboradores-payroll-summary.ts',
    ].map((file) => readFileSync(resolve(file), 'utf8')).join('\n');

    expect(html).toContain('Total da competência');
    expect(html).toContain('Pendências para revisar');
    expect(html).toContain('Contas a pagar geradas');
    expect(html).toContain('Pago / em aberto');
    expect(html).toContain('Histórico de fechamentos');
    expect(html).toContain('Fechar competência e gerar contas a pagar');
    expect(query).toContain('payroll_review_reasons');
    expect(query).toContain('payroll_history');
    expect(query).toContain('i.source_expense_id');
  });
});

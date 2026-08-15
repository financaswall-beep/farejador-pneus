import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve('db/migrations/0175_salary_payment_calendar.sql'), 'utf8',
);
const matrixRollover = readFileSync(
  resolve('src/admin/caixa/operation-salary-rollover.ts'), 'utf8',
);
const scheduler = readFileSync(resolve('src/monthly-continuity.ts'), 'utf8');

describe('migration 0175 — calendário de pagamento do salário', () => {
  it('mantém o valor semanal exato separado da folha mensal', () => {
    expect(migration).toContain("CHECK (salary_frequency IN ('weekly','monthly'))");
    expect(migration).toContain("CASE WHEN v_comp.salary_frequency='weekly' THEN 0 ELSE v_comp.base_salary END");
    expect(migration).toContain('Valor semanal exato definido na remuneracao');
    expect(migration).not.toMatch(/base_salary\s*\/\s*4/);
  });

  it('fecha domingo a sábado uma única vez e cria saída financeira própria', () => {
    expect(migration).toContain('extract(dow FROM period_start)=0');
    expect(migration).toContain('period_end=period_start+6');
    expect(migration).toContain('UNIQUE (environment,token_id,period_start)');
    expect(migration).toContain("'staff-salary-weekly:'");
    expect(matrixRollover).toContain('ensureMatrizExpenseAccrual');
    expect(matrixRollover).toContain('finance.matriz_salary_periods');
  });

  it('executa automaticamente para Matriz e parceiros', () => {
    expect(scheduler).toContain('closeMatrizWeeklySalaries');
    expect(scheduler).toContain('run_partner_staff_salary_rollover');
    expect(migration).toContain('sync_matriz_commission_expense_payment');
  });
});

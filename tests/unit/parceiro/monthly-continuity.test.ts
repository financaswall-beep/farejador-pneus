import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), 'db/migrations/0154_monthly_continuity.sql'),
  'utf8',
);
const payrollBridge = readFileSync(
  resolve(process.cwd(), 'db/migrations/0170_partner_payroll_commission_bridge.sql'),
  'utf8',
);
const operationTeam = readFileSync(
  resolve(process.cwd(), 'db/migrations/0171_operation_team_remuneration.sql'),
  'utf8',
);
const monthlyFees = readFileSync(
  resolve(process.cwd(), 'src/admin/painel/queries-mensalidades.ts'),
  'utf8',
);
const scheduler = readFileSync(
  resolve(process.cwd(), 'src/monthly-continuity.ts'),
  'utf8',
);
const server = readFileSync(
  resolve(process.cwd(), 'src/app/server.ts'),
  'utf8',
);
const pdv = readFileSync(
  resolve(process.cwd(), 'parceiro/public/app.pdv.js'),
  'utf8',
);
const reports = readFileSync(
  resolve(process.cwd(), 'parceiro/public/app.relatorios.js'),
  'utf8',
);

describe('continuidade mensal da Matriz e dos parceiros', () => {
  it('usa uma competencia explicita no calendario de Sao Paulo', () => {
    expect(migration).toContain('partner_payables.competence_month');
    expect(migration).toContain('partner_expenses.competence_month');
    expect(migration).toContain("AT TIME ZONE 'America/Sao_Paulo'");
    expect(pdv).toContain('this.dateKeySaoPaulo(new Date())');
    expect(reports).toContain("T00:00:00-03:00");
  });

  it('impede referencias cruzadas entre prod e test', () => {
    expect(migration).toContain('env_match_partner_terms_history_partner');
    expect(migration).toContain('env_match_staff_entry_order');
    expect(migration).toContain('env_match_staff_period_payable');
    expect(migration).toContain('env_match_staff_adjustment_entry');
    expect(migration).toContain('ops.enforce_environment_immutable()');
  });

  it('congela a comissao e fecha no maximo uma conta por pessoa e mes', () => {
    expect(migration).toContain('partner_staff_commission_entries_order_uniq');
    expect(migration).toContain('partner_staff_commission_periods_uniq');
    expect(migration).toContain('partner_staff_commission_fact_immutable');
    expect(migration).toContain('pg_advisory_xact_lock');
    expect(migration).toContain("'staff-commission:'");
  });

  it('carrega estorno posterior como ajuste negativo sem apagar o fechamento', () => {
    expect(migration).toContain('partner_staff_commission_adjustments');
    expect(migration).toContain('-v_entry.commission_amount');
    expect(migration).toContain('v_entry.settlement_period_id IS NOT NULL');
    expect(migration).toContain('v_totals.earned_amount+v_totals.adjustment_amount');
  });

  it('integra a comissão do parceiro à remuneração sem duplicar a saída', () => {
    expect(payrollBridge).toContain('finance.partner_payroll_periods');
    expect(payrollBridge).toContain('finance.partner_payroll_items');
    expect(payrollBridge).toContain('commission_period_id');
    expect(payrollBridge).toContain('payable_id');
    expect(payrollBridge).toContain('partner_payroll_backfill_incomplete');
    expect(payrollBridge).not.toContain('INSERT INTO finance.partner_expenses');
    expect(operationTeam).toContain('network.partner_collaborator_compensation');
    expect(operationTeam).toContain('finance.prepare_partner_payroll_period');
    expect(operationTeam).toMatch(/base_salary,\s*benefits,commission_amount,total_due/);
    expect(operationTeam).toContain('finance.run_partner_staff_payroll_seed');
    expect(operationTeam).not.toContain('INSERT INTO finance.partner_expenses');
    expect(scheduler).toContain('run_partner_staff_payroll_seed');
    expect(scheduler).toContain('run_partner_staff_salary_rollover');
  });

  it('recupera mensalidades atrasadas usando historico de termos', () => {
    expect(migration).toContain('partner_commercial_terms_history');
    expect(monthlyFees).toContain('generate_series');
    expect(monthlyFees).toContain('partner_commercial_terms_history');
    expect(monthlyFees).toContain('ON CONFLICT (environment,partner_id,competence) DO NOTHING');
  });

  it('roda no boot e periodicamente sem depender da abertura de uma tela', () => {
    expect(scheduler).toContain('runMonthlyContinuityCycle');
    expect(scheduler).toContain('MONTHLY_CONTINUITY_INTERVAL_MS');
    expect(server).toContain('startMonthlyContinuityScheduler()');
    expect(server).toContain('stopMonthlyContinuity?.()');
  });

  it('atravessa todas as viradas, inclusive dezembro e anos bissextos', () => {
    const transitions: Array<{ from: string; to: string; due: string }> = [];
    for (let year = 2024; year <= 2036; year += 1) {
      for (let month = 0; month < 12; month += 1) {
        const from = new Date(Date.UTC(year, month, 1));
        const to = new Date(Date.UTC(year, month + 1, 1));
        const due = new Date(Date.UTC(year, month + 1, 5));
        transitions.push({
          from: from.toISOString().slice(0, 10),
          to: to.toISOString().slice(0, 10),
          due: due.toISOString().slice(0, 10),
        });
      }
    }

    expect(transitions).toHaveLength(156);
    expect(transitions).toContainEqual({
      from: '2024-12-01',
      to: '2025-01-01',
      due: '2025-01-05',
    });
    expect(transitions).toContainEqual({
      from: '2024-02-01',
      to: '2024-03-01',
      due: '2024-03-05',
    });
    expect(transitions.every(({ to, due }) => due.slice(0, 7) === to.slice(0, 7)))
      .toBe(true);
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve('db/migrations/0174_commission_settlement_calendar.sql'), 'utf8',
);

describe('migration 0174 — calendário de pagamento das comissões', () => {
  it('oferece somente fechamento semanal ou mensal e congela a regra nos fatos', () => {
    expect(migration).toContain("CHECK (settlement_frequency IN ('weekly','monthly'))");
    expect(migration).toContain("NEW.settlement_frequency := COALESCE(v_rule.settlement_frequency,'monthly')");
    expect(migration).toContain('partner_staff_commission_fact_immutable');
  });

  it('fecha a semana de domingo a sábado sem misturar com a folha mensal', () => {
    expect(migration).toContain("extract(dow FROM realized_at AT TIME ZONE 'America/Sao_Paulo')::int");
    expect(migration).toContain("IF NEW.settlement_frequency='weekly' THEN");
    expect(migration).toContain("period.settlement_frequency='monthly'");
    expect(migration).toContain("AND settlement_frequency='weekly' AND settlement_period_id IS NULL");
  });

  it('separa períodos por frequência e impede dois fechamentos do mesmo ciclo', () => {
    expect(migration).toContain('UNIQUE (environment,token_id,settlement_frequency,period_start)');
    expect(migration).toContain("AND ((settlement_frequency='weekly'");
    expect(migration).toContain('finance.matriz_commission_periods');
    expect(migration).toContain('guard_matriz_commission_period');
    expect(migration).toContain('weekly_commission_expense_locked');
    expect(migration).toContain('sync_matriz_commission_expense_payment');
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('migration 0186 - datas factuais do sistema', () => {
  const sql = readFileSync('db/migrations/0186_system_business_fact_dates.sql', 'utf8');

  it('protege Matriz, parceiro e ledger pelo dia de São Paulo', () => {
    expect(sql).toContain("clock_timestamp() AT TIME ZONE 'America/Sao_Paulo'");
    expect(sql).toContain('matriz_expenses_business_timestamps_guard');
    expect(sql).toContain('partner_payables_business_time_guard');
    expect(sql).toContain('partner_receivables_business_time_guard');
    expect(sql).toContain('matriz_ledger_payments_business_time_guard');
  });

  it('não instala bloqueio nos vencimentos futuros', () => {
    expect(sql).not.toMatch(/guard_not_future_business_(?:timestamps|dates)\('due_date'/);
    expect(sql).not.toMatch(/EXECUTE FUNCTION[^\n]*\('payable_due_date'/);
  });
});

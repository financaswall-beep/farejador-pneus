import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('db/migrations/0199_system_continuity.sql', 'utf8');
const productionRunner = readFileSync('scripts/aplicar-0199-prod.cjs', 'utf8');

describe('migration 0199 — continuidade do sistema', () => {
  it('fixa o calendário de São Paulo e valida as proteções históricas', () => {
    expect(migration).toContain("now() AT TIME ZONE 'America/Sao_Paulo'");
    expect(migration).toContain('VALIDATE CONSTRAINT order_items_discount_within_line_check');
    expect(migration).toContain('VALIDATE CONSTRAINT wholesale_orders_payment_dates_check');
    expect(migration).toContain('VALIDATE CONSTRAINT commission_entries_partner_order_fk');
  });

  it('registra versão canônica e renova partições automaticamente', () => {
    expect(migration).toContain('ops.application_schema_state');
    expect(migration).toContain("VALUES (true,199,'0199_system_continuity.sql',now())");
    expect(migration).toContain('farejador-ensure-partitions');
    expect(migration).toContain('ops.ensure_monthly_partitions(6)');
  });

  it('limpa apenas resíduos encerrados e preserva o raw imutável', () => {
    expect(migration).toContain('ops.perform_operational_retention');
    expect(migration).toContain('farejador-operational-retention');
    expect(migration).not.toMatch(/DELETE\s+FROM\s+raw\./i);
    expect(migration).not.toMatch(/UPDATE\s+raw\.raw_events/i);
    expect(migration).not.toMatch(/DELETE\s+FROM\s+(commerce|finance)\./i);
  });

  it('exige autorização explícita e backup íntegro para produção', () => {
    expect(productionRunner).toContain("ALLOW_PROD_CONTINUITY_MIGRATION !== '0199'");
    expect(productionRunner).toContain("FAREJADOR_ENV !== 'prod'");
    expect(productionRunner).toContain('backup_hash_mismatch');
    expect(productionRunner).toContain("pg_advisory_xact_lock(hashtext('farejador:migrations:0199'))");
    expect(productionRunner).toContain("commit ? 'COMMIT' : 'ROLLBACK'");
  });
});

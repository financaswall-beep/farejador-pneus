import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = resolve(process.cwd(), 'db/migrations/0137_partner_historical_cost.sql');

describe('Etapa 6 — contrato do custo histórico da Rede', () => {
  it('mantém snapshot explícito e custo pendente no item vendido', () => {
    const sql = readFileSync(migrationPath, 'utf8');
    expect(sql).toContain('unit_cost_snapshot');
    expect(sql).toContain('cost_status');
    expect(sql).toContain("'known'");
    expect(sql).toContain("'pending'");
    expect(sql).toContain('guard_partner_order_item_cost_snapshot');
  });

  it('captura o custo na mesma função transacional que bloqueia o estoque', () => {
    const sql = readFileSync(migrationPath, 'utf8');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION commerce.register_partner_local_order');
    expect(sql).toMatch(/SELECT[\s\S]*average_cost[\s\S]*FOR UPDATE/);
    expect(sql).toMatch(/INSERT INTO commerce\.partner_order_items[\s\S]*unit_cost_snapshot/);
  });

  it('não usa o custo médio atual para recalcular o CMV histórico', () => {
    const sql = readFileSync(migrationPath, 'utf8');
    const view = sql.slice(sql.indexOf('CREATE OR REPLACE VIEW network.partner_unit_summary'));
    expect(view).toContain('oi.unit_cost_snapshot');
    expect(view).not.toContain('ps.average_cost');
    expect(view).toContain('pending_cost_items_month');
    expect(view).toContain('confirmed_result_month');
  });

  it('reafirma security_invoker nas views recriadas', () => {
    const sql = readFileSync(migrationPath, 'utf8');
    expect(sql.match(/WITH \(security_invoker = true\)/g)).toHaveLength(2);
  });

  it('remove UPDATE pós-venda do parceiro e não aceita GUC como autorização isolada', () => {
    const sql = readFileSync(migrationPath, 'utf8');
    expect(sql).toContain('REVOKE UPDATE ON commerce.partner_order_items');
    expect(sql).toContain("current_user <> pg_catalog.pg_get_userbyid");
    expect(sql).toContain('stage6_partner_can_update_cost_snapshot');
  });

  it('possui reconciliação administrativa idempotente com antes/depois', () => {
    const source = readFileSync(resolve(process.cwd(),
      'src/admin/painel/queries-rede-custos.ts'), 'utf8');
    expect(source).toContain("domain: 'partner.cost.reconcile'");
    expect(source).toContain("set_config('app.partner_cost_reconciliation','on',true)");
    expect(source).toContain("eventType: 'partner_item_cost_reconciled'");
    expect(source).toContain('before: before.rows[0]');
  });
});

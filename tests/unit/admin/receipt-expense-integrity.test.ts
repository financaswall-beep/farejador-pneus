import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(resolve(path), 'utf8');

describe('0145 — integridade da despesa vinculada ao comprovante', () => {
  it('bloqueia soft-delete de despesa ligada a comprovante terminal', () => {
    const migration = source('db/migrations/0145_matriz_receipt_expense_integrity.sql');

    expect(migration).toContain('protect_matriz_receipt_expense');
    expect(migration).toContain("workflow_status IN ('linked','legacy_linked')");
    expect(migration).toContain("RAISE EXCEPTION 'receipt_expense_locked'");
    expect(migration).toContain('BEFORE UPDATE OF deleted_at');
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION finance.protect_matriz_receipt_expense() FROM PUBLIC',
    );
  });

  it('repara a mesma despesa sem criar dinheiro ou trocar o vínculo', () => {
    const query = source('src/admin/painel/queries-logistica-comprovantes-repair.ts');

    expect(query).toContain("domain: 'receipt.repair_expense'");
    expect(query).toContain("['linked', 'legacy_linked']");
    expect(query).toContain('SET deleted_at=NULL,deleted_by=NULL,delete_reason=NULL');
    expect(query).not.toContain('INSERT INTO commerce.matriz_expenses');
    expect(query).not.toContain('UPDATE commerce.matriz_trip_receipts');
    expect(query).toContain("eventType: 'linked_expense_restored'");
  });

  it('expõe reparo somente ao owner e apresenta ação apenas no vínculo quebrado', () => {
    const route = source('src/admin/painel/route-logistica-rotas.ts');
    const frontend = source('painel/public/app.logistica.comprovantes.js');
    const html = source('painel/public/index.html');

    const repair = route.slice(
      route.indexOf("'/admin/api/logistica/comprovantes/reparar-despesa'"),
      route.indexOf('// Bytes do comprovante'),
    );
    expect(repair).toContain('preHandler: requireAdminOwner');
    expect(repair).toContain('repairMatrizTripReceiptExpense');
    expect(frontend).toContain('async repairReceiptExpense(receipt)');
    expect(html).toContain("r.expense_removed && adminUser?.role === 'owner'");
  });
});

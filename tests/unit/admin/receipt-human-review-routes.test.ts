import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(resolve(path), 'utf8');

describe('Etapa 7 — portaria da decisao humana', () => {
  it('expoe aprovacao e rejeicao apenas na portaria administrativa autenticada', () => {
    const admin = source('src/admin/painel/route-logistica-rotas.ts');
    const courier = source('src/admin/entregador/route.ts');

    expect(admin).toContain("'/admin/api/logistica/comprovantes/aprovar'");
    expect(admin).toContain("'/admin/api/logistica/comprovantes/rejeitar'");
    expect(admin).toContain('preHandler: requireAdminAuth');
    expect(admin).toContain('getAdminContext(request)');
    expect(admin).toContain('operatorLabel(request)');
    expect(courier).not.toContain('/comprovantes/aprovar');
    expect(courier).not.toContain('/comprovantes/rejeitar');
  });

  it('falha fechada por flags e nunca aceita ator vindo do schema', () => {
    const route = source('src/admin/painel/route-logistica-rotas.ts');
    const schemas = source('src/admin/painel/route-logistica.ts');
    const env = source('src/shared/config/env.ts');

    expect(route).toContain('MATRIZ_RECEIPT_APPROVAL');
    expect(route).toContain('MATRIZ_EXPENSES');
    expect(env).toContain('MATRIZ_RECEIPT_APPROVAL: booleanStringSchema');
    expect(env).toContain("default('10000')");
    const decisionSchemas = schemas.slice(
      schemas.indexOf('const receiptDecisionBaseSchema'),
      schemas.indexOf('export async function registerPainelLogistica'),
    );
    expect(decisionSchemas).not.toMatch(/actor_(label|admin_id)\s*:/);
  });

  it('mantem fechamento e extracao fora do nucleo que cria a despesa', () => {
    const close = source('src/admin/painel/queries-logistica-rotas.ts');
    const ai = source('src/admin/painel/queries-logistica-comprovantes-review.ts');
    const decision = source('src/admin/painel/queries-logistica-comprovantes-decision.ts');

    expect(close).not.toContain('INSERT INTO commerce.matriz_expenses');
    expect(ai).not.toContain('insertMatrizExpenseInTransaction');
    expect(decision).toContain('insertMatrizExpenseInTransaction');
    expect(decision).toContain("domain: 'receipt.approve'");
    expect(decision).toContain("domain: 'receipt.reject'");
  });
});

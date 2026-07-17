import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(path), 'utf8');
}

describe('Etapa 7 — IA de comprovante apenas sugere', () => {
  it('remove qualquer escrita financeira do processamento da IA', () => {
    const receipts = source('src/admin/painel/queries-logistica-comprovantes.ts');

    expect(receipts).not.toContain('INSERT INTO commerce.matriz_expenses');
    expect(receipts).not.toContain("'ia-comprovante'");
    expect(receipts).not.toContain('paid_at, created_by');
  });

  it('faz painel e entregador persistirem sugestao sem chamar o lancador antigo', () => {
    const adminRoute = source('src/admin/painel/route-logistica-rotas.ts');
    const courierRoute = source('src/admin/entregador/route.ts');

    expect(adminRoute).not.toContain('recordReceiptAiResult');
    expect(courierRoute).not.toContain('recordReceiptAiResult');
    expect(adminRoute).toContain('extractReceiptSuggestion');
    expect(courierRoute).toContain('extractReceiptSuggestion');
    const flow = readFileSync(resolve('src/admin/painel/receipt-ai-flow.ts'), 'utf8');
    expect(flow).toContain('completeReceiptAiAttempt');
  });

  it('mantem erro de transporte reprocessavel e sem efeito financeiro', () => {
    const reader = source('src/admin/painel/receipt-ai.ts');
    const review = source('src/admin/painel/queries-logistica-comprovantes-review.ts');

    expect(reader).not.toContain('matriz_expenses');
    expect(review).toContain("status: 'failed'");
    expect(review).toContain("workflow_status = 'review_required'");
    expect(review).not.toContain('INSERT INTO commerce.matriz_expenses');
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const partialSourceTypes = [
  'commerce.wholesale_purchase.partial_payment',
  'commerce.wholesale_order.partial_payment',
  'commerce.order.partial_payment',
];

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('saúde do livro central para pagamentos parciais', () => {
  it.each([
    'src/admin/painel/matriz-ledger-integration-health.ts',
    'db/migrations/0215_partial_payment_reconciliation_health.sql',
  ])('%s reconcilia os três tipos pela origem preservada', (path) => {
    const contents = source(path);
    for (const sourceType of partialSourceTypes) {
      expect(contents).toContain(`WHEN t.source_type='${sourceType}'`);
    }
    expect(contents.match(/THEN t\.metadata->>'source_id'/g)).toHaveLength(3);
  });

  it('a migration corrige somente a leitura e preserva o livro existente', () => {
    const migration = source(
      'db/migrations/0215_partial_payment_reconciliation_health.sql',
    );
    expect(migration).not.toMatch(
      /\b(?:UPDATE|DELETE\s+FROM)\s+finance\.matriz_ledger_transactions/i,
    );
  });
});

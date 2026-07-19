import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(resolve(path), 'utf8');

describe('Etapa 10 - fronteiras de logistica e folha', () => {
  it('remove dialogos nativos dos fluxos de logistica tocados', () => {
    const touchedFlows = [
      'painel/public/app.logistica.acoes.js',
      'painel/public/app.logistica.js',
      'painel/public/entregas.js',
    ];
    for (const file of touchedFlows) {
      expect(source(file), file).not.toMatch(/\b(?:window\.)?(?:confirm|prompt)\s*\(/);
    }
  });

  it('nao mistura a folha/rota da Matriz com o livro de comissao da Rede', () => {
    const stage10Sources = [
      'src/admin/painel/queries-logistica-rotas.ts',
      'src/admin/painel/queries-logistica-read.ts',
      'src/admin/painel/queries-colaboradores-gestao.ts',
      'src/admin/painel/queries-colaboradores-folha.ts',
    ].map(source).join('\n');
    expect(stage10Sources).not.toContain('network.commission_entries');
    const migration = source('db/migrations/0143_matriz_logistics_payroll_consistency.sql');
    expect(migration).not.toMatch(/(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\s+network\.commission_entries/i);
    expect(migration).not.toMatch(/UPDATE\s+commerce\.matriz_delivery_trips[\s\S]{0,500}fuel_expense_id/i);
  });
});

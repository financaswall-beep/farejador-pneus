import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getMatrizLogistica } from '../../../src/admin/painel/queries-logistica.js';

describe('getMatrizLogistica — resultado real por rota', () => {
  it('busca custo congelado por pedido e despesas vinculadas sem usar valor fixo de combustível', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const db = { query } as unknown as Pool;

    await getMatrizLogistica('test', db);

    const tripQueries = query.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => sql.includes('commerce.matriz_delivery_trips t'));

    expect(tripQueries).toHaveLength(2);
    for (const sql of tripQueries) {
      expect(sql).toContain("'custo_pneus'");
      expect(sql).toContain('oi4.matriz_unit_cost * oi4.quantity');
      expect(sql).toContain('AS pedidos_resultado');
      expect(sql).toContain('AS despesas');
      expect(sql).toContain('commerce.matriz_expenses e2');
      expect(sql).toContain('r3.ai_expense_id = e2.id');
      expect(sql).toContain("CASE WHEN r3.id IS NULL THEN 'fechamento' ELSE 'comprovante' END");
      expect(sql).toContain("'expense_amount', e3.amount");
    }
  });

  it('abre o resultado dentro de Rotas e tira a digitação manual de combustível da tela ativa', () => {
    const html = readFileSync(resolve('painel/public/index.html'), 'utf8');
    const telaAtiva = html.split('<!-- Legado preservado como referência inerte')[0]!;
    const actions = readFileSync(resolve('painel/public/app.logistica.acoes.js'), 'utf8');

    expect(telaAtiva).toContain('Ver resultado');
    expect(telaAtiva).toContain("logisticaTab === 'rotas' && logisticaRotaSelecionada()");
    expect(telaAtiva).toContain('Comprovante de despesa');
    expect(telaAtiva).not.toContain('x-model="fecharForm.fuel_spent"');
    expect(actions).toContain('fuel_spent: null');
  });
});

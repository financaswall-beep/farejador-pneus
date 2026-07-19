import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

let getMatrizLogistica: typeof import('../../../src/admin/painel/queries-logistica.js').getMatrizLogistica;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test', FAREJADOR_ENV: 'prod', DATABASE_URL: 'postgres://test',
    CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'emergency-token',
  });
  ({ getMatrizLogistica } = await import('../../../src/admin/painel/queries-logistica.js'));
});

describe('getMatrizLogistica — resultado real por rota', () => {
  it('usa o fundo panorâmico no cabeçalho da Logística e o serve como WebP', () => {
    const html = readFileSync(resolve('painel/public/index.html'), 'utf8');
    const staticRoutes = readFileSync(resolve('src/admin/painel/route-static.ts'), 'utf8');
    const banner = statSync(resolve('painel/public/assets/logistica-hero.webp'));

    expect(html).toContain("url('/admin/painel/assets/logistica-hero.webp?v=20260718-logistica2')");
    expect(html).toContain('aria-labelledby="logistica-heading"');
    expect(html).toContain('relative -mx-8 -mt-8 mb-5 min-h-[260px]');
    expect(html).toContain('id="logistica-heading"');
    expect(html).toContain('absolute right-8 top-5 z-10');
    expect(html).toContain('bg-gradient-to-r from-slate-950 via-slate-900 to-emerald-600');
    expect(staticRoutes).toContain("fastify.get('/admin/painel/assets/logistica-hero.webp'");
    expect(staticRoutes).toContain("'assets/logistica-hero.webp', 'image/webp'");
    expect(banner.size).toBeGreaterThan(0);
    expect(banner.size).toBeLessThan(100_000);
  });

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

  it('trata gasolina reportada sem comprovante aprovado como alerta, nunca como dinheiro', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const db = { query } as unknown as Pool;

    await getMatrizLogistica('test', db);

    const tripQueries = query.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => sql.includes('commerce.matriz_delivery_trips t'));
    const resultModule = readFileSync(resolve('painel/public/app.logistica.resultado.js'), 'utf8');

    expect(tripQueries).toHaveLength(2);
    for (const sql of tripQueries) {
      expect(sql).toContain('fuel_spent_without_approved_expense');
      expect(sql).toContain('workflow_status');
      expect(sql).toContain('legacy_linked');
      expect(sql).toContain('e2.id = t.fuel_expense_id');
    }
    expect(resultModule).toContain('Conciliação pendente');
    expect(resultModule).toContain("financialStatus === 'reconciled'");
    expect(resultModule).toContain('sem comprovante aprovado');
    expect(resultModule).toContain('fuel_spent_without_approved_expense');
  });

  it('fechar rota persiste o dado operacional e nao cria matriz_expenses', () => {
    const closeSource = readFileSync(
      resolve('src/admin/painel/queries-logistica-rotas.ts'),
      'utf8',
    );

    expect(closeSource).toContain('fuel_spent = COALESCE');
    expect(closeSource).not.toContain('INSERT INTO commerce.matriz_expenses');
    expect(closeSource).not.toContain("'logistica-fechamento'");
  });
});

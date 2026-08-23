import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import type { Pool, PoolClient } from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { setWholesaleStockSchema } from '../../../src/admin/painel/route-schemas.js';

function stockModule() {
  const sandbox = { window: { PAINEL_MODULES: {} }, console, setTimeout };
  for (const file of ['app.galpao.ajuste.js', 'app.galpao.js']) {
    vm.runInNewContext(
      readFileSync(resolve('painel/public', file), 'utf8'),
      sandbox,
    );
  }
  return {
    ...sandbox.window.PAINEL_MODULES.galpaoAjuste(),
    ...sandbox.window.PAINEL_MODULES.galpao(),
  };
}

function context(overrides: Record<string, unknown> = {}) {
  const module = stockModule();
  return {
    ...module,
    stockForm: {
      measure: '90/90-18',
      brand: 'Pirelli',
      tire_condition: 'meia_vida',
      quantity_on_hand: 10,
      unit_cost: 100,
      min_quantity: 2,
      notes: '',
      entry_reason: '',
      original_quantity_on_hand: 10,
      original_unit_cost: 100,
    },
    stockSaving: false,
    stockMsg: null,
    apiPost: vi.fn(async () => ({ quantity_on_hand: 10 })),
    loadAtacado: vi.fn(async () => undefined),
    loadStockReconciliation: vi.fn(async () => undefined),
    loadSino: vi.fn(async () => undefined),
    ...overrides,
  };
}

function stockPool(current = { quantity_on_hand: 10, unit_cost: '100.00' }) {
  const release = vi.fn();
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('SELECT DISTINCT tire_size')) {
      return {
        rows: [{
          tire_size: '90/90-18',
          width_mm: 90,
          aspect_ratio: 90,
          rim_diameter: 18,
        }],
      };
    }
    if (sql.includes('SELECT quantity_on_hand,unit_cost::text')) {
      return { rows: current ? [current] : [] };
    }
    if (sql.includes('INSERT INTO commerce.wholesale_stock')) {
      return {
        rows: [{
          measure: '90/90-18',
          brand: params?.[2],
          tire_condition: params?.[3],
          quantity_on_hand: params?.[4],
          unit_cost: String(params?.[5] ?? 0),
          min_quantity: params?.[6] ?? null,
          notes: params?.[7] ?? null,
          updated_at: '2026-07-27T00:00:00.000Z',
          tire_width_mm: 90,
          tire_aspect_ratio: 90,
          tire_rim_diameter: 18,
        }],
      };
    }
    return { rows: [] };
  });
  const client = { query, release } as unknown as PoolClient;
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  return { pool, query, release };
}

async function auditedStockSetter() {
  vi.stubEnv('FAREJADOR_ENV', 'test');
  vi.stubEnv('DATABASE_URL', 'postgresql://test:test@127.0.0.1:5432/farejador_test');
  vi.stubEnv('CHATWOOT_HMAC_SECRET', 'stock-adjustment-unit-test-secret');
  vi.stubEnv('ADMIN_AUTH_TOKEN', 'stock-adjustment-unit-test-admin-token');
  return (await import('../../../src/admin/painel/queries-galpao-movimentos.js'))
    .setWholesaleStockComRotulo;
}

describe('Ajuste manual do Estoque com motivo auditável', () => {
  const html = readFileSync(resolve('painel/public/index.html'), 'utf8');
  const montagem = readFileSync(resolve('painel/public/app.montagem.js'), 'utf8');
  const staticRoutes = readFileSync(resolve('src/admin/painel/route-static.ts'), 'utf8');
  const actions = readFileSync(
    resolve('src/admin/painel/queries-galpao-movimentos.ts'),
    'utf8',
  );

  it('mostra o campo e a prévia de impacto dentro do formulário de ajuste', () => {
    expect(html).toContain('Motivo do ajuste');
    expect(html).toContain('Impacto do ajuste');
    expect(html).toContain('Variação no valor do estoque');
    expect(html).toContain('stockAdjustmentChangesValue()');
    expect(html).toContain('stockAdjustmentImpact()');
    expect(html).toContain('app.galpao.ajuste.js?v=20260727-stock-adjustment1');
    expect(html).toContain('app.montagem.js?v=20260823-partner-pickups1');
    expect(html).toContain('app.js?v=20260823-partner-summary1');
    expect(montagem).toContain('window.PAINEL_MODULES.galpaoAjuste');
    expect(staticRoutes).toContain("'app.galpao.ajuste.js'");
  });

  it('trava a identidade no ajuste comum e direciona a troca para Corrigir marca', () => {
    const app = context();
    app.stockEdit({
      measure: '100/80-18', brand: 'Sem marca', tire_condition: 'meia_vida',
      quantity_on_hand: 10, unit_cost: 55.4, min_quantity: 2, notes: null,
    });

    expect(app.stockForm).toMatchObject({
      measure: '100/80-18', brand: 'Sem marca', tire_condition: 'meia_vida',
      identity_locked: true,
    });
    expect(html).toContain(':disabled="stockForm.identity_locked"');
    expect(html).toContain('catalogoBrandCorrectionFromStock(selectedRow)');
    expect(html).toContain('Para trocar a marca, use Corrigir marca.');
  });

  it('bloqueia alteração de saldo ou custo sem motivo', async () => {
    const app = context();
    app.stockForm.quantity_on_hand = 9;

    await app.stockSubmit();

    expect(app.apiPost).not.toHaveBeenCalled();
    expect(app.stockMsg).toEqual({
      ok: false,
      text: 'Informe o motivo da alteração de saldo ou custo.',
    });
  });

  it('permite alterar somente mínimo/observações sem impacto financeiro', async () => {
    const app = context();
    app.stockForm.min_quantity = 4;

    await app.stockSubmit();

    expect(app.apiPost).toHaveBeenCalledWith('/admin/api/wholesale/stock', expect.objectContaining({
      measure: '90/90-18',
      quantity_on_hand: 10,
      unit_cost: 100,
      min_quantity: 4,
      reason: undefined,
    }));
  });

  it('envia o motivo real e calcula a variação de valor antes de salvar', async () => {
    const app = context();
    app.stockForm.unit_cost = 120;
    app.stockForm.entry_reason = 'Correção do custo digitado na contagem';

    expect(app.stockAdjustmentImpact()).toMatchObject({
      valueBefore: 1000,
      valueAfter: 1200,
      valueDelta: 200,
    });
    await app.stockSubmit();

    expect(app.apiPost).toHaveBeenCalledWith('/admin/api/wholesale/stock', expect.objectContaining({
      unit_cost: 120,
      reason: 'Correção do custo digitado na contagem',
    }));
  });

  it('aceita o motivo no contrato HTTP e o servidor o exige quando há impacto', () => {
    expect(setWholesaleStockSchema.safeParse({
      measure: '90/90-18', brand: 'Pirelli', tire_condition: 'meia_vida',
      quantity_on_hand: 10, unit_cost: 100,
      reason: 'Contagem física conferida',
    }).success).toBe(true);
    expect(setWholesaleStockSchema.safeParse({
      measure: '90/90-18', brand: 'Pirelli', tire_condition: 'meia_vida',
      quantity_on_hand: 10, unit_cost: 100,
      reason: '',
    }).success).toBe(false);
    expect(actions).toContain("if (valueChanged && reason.length < 2) throw new Error('reason_required')");
    expect(actions).toContain("reason: valueChanged ? reason :");
    expect(actions).toContain("input.actor_label ?? 'system:stock-adjustment'");
  });

  it('repete a proteção no servidor e faz rollback quando o motivo não veio', async () => {
    const { pool, query, release } = stockPool();
    const setWholesaleStockComRotulo = await auditedStockSetter();

    await expect(setWholesaleStockComRotulo({
      environment: 'test',
      measure: '90/90-18',
      brand: 'Pirelli',
      quantity_on_hand: 9,
      unit_cost: 100,
    }, pool)).rejects.toThrow('reason_required');

    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes('INSERT INTO commerce.wholesale_stock'))).toBe(false);
    expect(query).toHaveBeenCalledWith('ROLLBACK');
    expect(release).toHaveBeenCalledOnce();
  });

  it('grava o motivo real no contexto do movimento antes do ajuste', async () => {
    const { pool, query } = stockPool();
    const setWholesaleStockComRotulo = await auditedStockSetter();

    await expect(setWholesaleStockComRotulo({
      environment: 'test',
      measure: '90/90-18',
      brand: 'Pirelli',
      quantity_on_hand: 8,
      unit_cost: 100,
      reason: 'Contagem física conferida pelo responsável',
      actor_label: 'Wallace',
    }, pool)).resolves.toMatchObject({
      measure: '90/90-18',
      quantity_on_hand: 8,
    });

    const contextCall = query.mock.calls.find(([sql]) =>
      String(sql).includes("set_config('app.galpao_source'"));
    expect(contextCall?.[1]?.slice(0, 3)).toEqual([
      'definir',
      'inventory_count',
      'Contagem física conferida pelo responsável',
    ]);
    expect(query).toHaveBeenCalledWith('COMMIT');
  });
});

afterAll(() => {
  vi.unstubAllEnvs();
});

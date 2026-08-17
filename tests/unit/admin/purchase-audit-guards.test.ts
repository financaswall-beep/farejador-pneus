import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertWholesalePurchaseMoney,
} from '../../../src/admin/painel/purchase-money.js';

function source(path: string): string {
  return readFileSync(resolve(path), 'utf8');
}

describe('guardas finais das auditorias de Compras', () => {
  it('protege todas as mutações HTTP com proprietário', () => {
    const route = source('src/admin/painel/route-fornecedores.ts');
    for (const endpoint of [
      '/admin/api/wholesale/suppliers',
      '/admin/api/wholesale/purchases',
      '/admin/api/wholesale/purchases/confirm',
      '/admin/api/wholesale/purchases/cancel',
      '/admin/api/wholesale/suppliers/archive',
    ]) {
      const escaped = endpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(route).toMatch(new RegExp(`post\\('${escaped}'[\\s\\S]{0,90}requireAdminOwner`));
    }
  });

  it('calcula giro de 30 dias no banco e o front usa esse valor', () => {
    const backend = source('src/admin/painel/queries-galpao.ts');
    const frontend = source('painel/public/app.galpao.multibrand.js');
    expect(backend).toContain("created_at>=now()-INTERVAL '30 days'");
    expect(backend).toContain("source IN ('venda_atacado','varejo')");
    expect(frontend).toContain("row?.sales_30d != null");
  });

  it('recusa estouro também para chamadas internas que contornem a rota', () => {
    expect(() => assertWholesalePurchaseMoney([
      { quantity: 100_000, unit_cost: 9_999_999.99 },
    ])).toThrow('purchase_line_total_too_large');
    expect(() => assertWholesalePurchaseMoney([
      { quantity: 1, unit_cost: 2.135 },
    ])).toThrow('unit_cost_cent_precision');
  });

  it('mantém Compras somente leitura no front para não proprietários', () => {
    const html = source('painel/public/index.html');
    const actions = source('painel/public/app.compras.acoes.js');
    expect(html).toContain("comprasTab === 'nova' && adminUser?.role === 'owner'");
    expect(html).toContain('Compras está em modo somente leitura');
    expect(actions.match(/adminUser\?\.role !== 'owner'/g)?.length).toBeGreaterThanOrEqual(7);
  });
});

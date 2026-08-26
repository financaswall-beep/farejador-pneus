import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertWholesalePurchaseMoney, calculateWholesalePurchaseMoney,
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
      '/admin/api/wholesale/purchases/link-order',
      '/admin/api/wholesale/purchases/cancel',
      '/admin/api/wholesale/suppliers/archive',
    ]) {
      const escaped = endpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(route).toMatch(new RegExp(`post\\('${escaped}'[\\s\\S]{0,90}requireAdminOwner`));
    }
  });

  it('calcula giro de 30 dias no banco e o front usa esse valor', () => {
    const backend = source('src/admin/painel/queries-galpao-list.ts');
    const frontend = source('painel/public/app.galpao.multibrand.js');
    expect(backend).toContain("created_at>=now()-INTERVAL '30 days'");
    for (const sourceName of [
      'venda_atacado', 'varejo', 'cancelamento_venda', 'cancelamento_varejo',
    ]) expect(backend).toContain(`'${sourceName}'`);
    expect(backend).toContain('GREATEST(0,-COALESCE(sum(qty_delta),0))');
    expect(frontend).toContain("row?.sales_30d != null");
  });

  it('desconta compras pendentes do plano sem alterar o saldo oficial', () => {
    const backend = source('src/admin/painel/queries-galpao-list.ts');
    const frontend = source('painel/public/app.galpao.multibrand.js');
    expect(backend).toContain('pending_receipts AS');
    expect(backend).toContain("WHERE p.status='pending'");
    expect(backend).toContain('i.quantity-COALESCE(i.accepted_quantity,0)');
    expect(backend).toContain('COALESCE(pr.units,0)::int AS in_transit_quantity');
    expect(frontend).toContain('minimum - balance - inTransit');
    expect(frontend).toContain('this.comprasReplenishmentBuild');
    expect(frontend).toContain('row.suggested_quantity > 0');
  });

  it('recusa estouro também para chamadas internas que contornem a rota', () => {
    expect(() => assertWholesalePurchaseMoney([
      { quantity: 100_000, unit_cost: 9_999_999.99 },
    ])).toThrow('purchase_line_total_too_large');
    expect(() => assertWholesalePurchaseMoney([
      { quantity: 1, unit_cost: 2.135 },
    ])).toThrow('unit_cost_cent_precision');
  });

  it('fecha produtos, frete e desconto em centavos sem perder valor no rateio', () => {
    const result = calculateWholesalePurchaseMoney([
      { quantity: 2, unit_cost: 45.01 },
      { quantity: 1, unit_cost: 45 },
    ], 10, 0.02);
    expect(result).toMatchObject({
      productsCents: 13_502, freightCents: 1_000,
      discountCents: 2, totalCents: 14_500,
    });
    expect(result.allocatedItemCents.reduce((sum, value) => sum + value, 0)).toBe(14_500);
  });

  it('rateia por quantidade quando todos os itens têm custo zero', () => {
    const result = calculateWholesalePurchaseMoney([
      { quantity: 1, unit_cost: 0 }, { quantity: 3, unit_cost: 0 },
    ], 1, 0);
    expect(result.allocatedItemCents).toEqual([25, 75]);
  });

  it('recusa desconto superior a produtos mais frete', () => {
    expect(() => calculateWholesalePurchaseMoney([
      { quantity: 1, unit_cost: 5 },
    ], 1, 6.01)).toThrow('discount_exceeds_purchase');
  });

  it('mantém Compras somente leitura no front para não proprietários', () => {
    const html = source('painel/public/index.html');
    const actions = source('painel/public/app.compras.acoes.js');
    expect(html).toContain("comprasTab === 'nova' && adminUser?.role === 'owner'");
    expect(html).toContain('Compras está em modo somente leitura');
    expect(actions.match(/adminUser\?\.role !== 'owner'/g)?.length).toBeGreaterThanOrEqual(7);
  });
});

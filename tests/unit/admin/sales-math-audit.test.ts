import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertRetailSaleMoney, assertWholesaleSaleMoney,
} from '../../../src/admin/painel/sales-money.js';
import {
  registerManualOrderSchema, registerWalkinOrderSchema,
} from '../../../src/admin/painel/route-schemas-orders.js';
import { registerWholesaleSaleSchema } from '../../../src/admin/painel/route-schemas.js';

const productId = '22222222-2222-4222-8222-222222222222';
const conversationId = '11111111-1111-4111-8111-111111111111';

function retailBody() {
  return {
    conversation_id: conversationId,
    items: [{ product_id: productId, quantity: 1, unit_price: 10, discount_amount: 0 }],
    payment_method: 'pix', fulfillment_mode: 'pickup' as const,
    idempotency_key: 'retail-math-audit',
  };
}

function wholesaleBody() {
  return {
    new_customer: { name: 'Borracharia Matemática' },
    items: [{ measure: '90/90-18', brand: 'Pirelli', tire_condition: 'meia_vida' as const,
      quantity: 1, unit_price: 10 }],
    idempotency_key: 'wholesale-math-audit',
  };
}

describe('auditoria matemática formal de Vendas', () => {
  it('soma varejo em centavos exatos com quantidade e desconto', () => {
    expect(assertRetailSaleMoney([
      { quantity: 3, unit_price: 19.99, discount_amount: 0.02 },
      { quantity: 2, unit_price: 0.10 },
    ])).toBe(6_015);
  });

  it('soma atacado em centavos exatos', () => {
    expect(assertWholesaleSaleMoney([
      { quantity: 3, unit_price: 19.99 },
      { quantity: 2, unit_price: 0.10 },
    ])).toBe(6_017);
  });

  it('recusa frações de centavo no serviço e nas três bordas HTTP', () => {
    expect(() => assertRetailSaleMoney([{ quantity: 1, unit_price: 2.135 }]))
      .toThrow('unit_price_cent_precision');
    expect(() => assertRetailSaleMoney([{
      quantity: 1, unit_price: 10, discount_amount: 0.005,
    }])).toThrow('discount_cent_precision');
    expect(() => assertWholesaleSaleMoney([{ quantity: 1, unit_price: 2.135 }]))
      .toThrow('unit_price_cent_precision');

    expect(registerManualOrderSchema.safeParse({
      ...retailBody(), items: [{ product_id: productId, quantity: 1, unit_price: 2.135 }],
    }).error?.issues[0]?.message).toBe('unit_price_cent_precision');
    expect(registerWalkinOrderSchema.safeParse({
      ...retailBody(), conversation_id: undefined, source_tag: 'walkin_balcao',
      items: [{ product_id: productId, quantity: 1, unit_price: 10, discount_amount: 0.005 }],
    }).error?.issues[0]?.message).toBe('discount_cent_precision');
    expect(registerWholesaleSaleSchema.safeParse({
      ...wholesaleBody(), items: [{ ...wholesaleBody().items[0], unit_price: 2.135 }],
    }).error?.issues[0]?.message).toBe('unit_price_cent_precision');
  });

  it('recusa linha, desconto e total que não cabem no banco', () => {
    expect(() => assertRetailSaleMoney([{
      quantity: 2, unit_price: 99_999_999.99,
    }])).toThrow('sale_line_total_too_large');
    expect(() => assertRetailSaleMoney([{
      quantity: 1, unit_price: 10, discount_amount: 10.01,
    }])).toThrow('discount_exceeds_line_total');
    expect(() => assertWholesaleSaleMoney([{
      quantity: 100_000, unit_price: 9_999_999.99,
    }])).toThrow('sale_line_total_too_large');
    expect(() => assertRetailSaleMoney(Array.from({ length: 101 }, () => ({
      quantity: 1, unit_price: 0.01,
    })))).toThrow('sale_items_limit');
    expect(() => assertWholesaleSaleMoney(Array.from({ length: 51 }, () => ({
      quantity: 1, unit_price: 0.01,
    })))).toThrow('sale_items_limit');
  });

  it('aceita vencimento futuro como crédito, sem transformar a venda em data futura', () => {
    expect(registerWholesaleSaleSchema.safeParse({
      ...wholesaleBody(), sold_at: '2026-08-10T12:00:00-03:00',
      payment_status: 'pending', due_date: '2026-09-10',
    }).success).toBe(true);
    expect(registerManualOrderSchema.safeParse({
      ...retailBody(), payment_method: 'a receber', payment_due_on: '2026-09-10',
    }).success).toBe(true);
  });

  it('usa venda realizada e sold_at em todos os consumidores matemáticos', () => {
    const commission = readFileSync(resolve('src/admin/caixa/operation-commission-facts.ts'), 'utf8');
    const team = readFileSync(resolve('src/admin/painel/queries-colaboradores-gestao.ts'), 'utf8');
    const finance = readFileSync(resolve('src/admin/painel/queries-financeiro-visao.ts'), 'utf8');
    const truth = readFileSync(resolve('src/admin/painel/queries-financeiro-verdade.ts'), 'utf8');
    const caixa = readFileSync(resolve('src/admin/caixa/sales.ts'), 'utf8');
    const marketing = readFileSync(resolve('src/marketing/attribution.ts'), 'utf8');
    const varejoUi = readFileSync(resolve('painel/public/app.varejo.js'), 'utf8');
    for (const source of [commission, team, finance, truth, caixa, marketing]) {
      expect(source).toContain("status IN ('confirmed','paid','delivered')");
    }
    expect(commission).toContain('o.sold_at occurred_at');
    expect(team).toContain("(o.sold_at AT TIME ZONE 'America/Sao_Paulo')::date AS event_date");
    expect(finance).toContain("(o.sold_at AT TIME ZONE 'America/Sao_Paulo') ${mesWhere}");
    expect(truth).toContain("status='confirmed' AND sold_at>=month_start");
    expect(varejoUi).toContain("!['Cancelado', 'Aberto', 'Pendente'].includes(p.status)");
  });
});

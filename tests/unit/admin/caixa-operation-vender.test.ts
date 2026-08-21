import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(file: string): string {
  return readFileSync(resolve(file), 'utf8');
}

describe('Etapa 2 - Vender na Operação da Loja', () => {
  const html = source('painel/public/caixa.html');
  const core = source('painel/public/caixa-core.js');
  const login = source('painel/public/caixa.js');
  const catalog = source('painel/public/caixa-checkout-catalog.js');
  const checkout = source('painel/public/caixa-checkout.js');
  const pricing = source('painel/public/caixa-checkout-pricing.js');
  const checkoutSession = source('painel/public/caixa-checkout-session.js');
  const partnerRoute = source('src/parceiro/route.ts');
  const partnerQueries = source('src/parceiro/queries.ts');
  const partnerPricing = source('src/parceiro/partner-sale-pricing.ts');
  const operationLogin = source('src/admin/caixa/route-operation-login.ts');

  it('mantém Matriz e parceiro na mesma tela e identifica operador e unidade', () => {
    expect(html).toContain('id="app-heading-title">Vender</h2>');
    expect(html).toContain('id="operation-unit-label"');
    expect(core).toContain("scope: '2w_caixa_escopo'");
    expect(core).toContain("elements.operationUnitLabel.textContent = unitName");
    expect(login).toContain("Caixa.showSession(payload)");
    expect(operationLogin).toContain('display_name: workplace.displayName');
    expect(operationLogin).toContain('modules: workplace.modules');
  });

  it('normaliza somente o catálogo e o estoque da unidade autenticada', () => {
    expect(checkout).toContain("Caixa.operationPath('produtos')");
    expect(catalog).toContain('row.quantity_on_hand || 0');
    expect(catalog).toContain('row.quantity_reserved || 0');
    expect(catalog).toContain('partner_stock_id: row.stock_id');
    expect(partnerRoute).toContain("fastify.get('/parceiro/:slug/api/produtos'");
    expect(partnerQueries).toContain('WHERE environment = $1 AND unit_id = $2 AND deleted_at IS NULL');
  });

  it('finaliza de forma idempotente e atribui a venda ao login do parceiro', () => {
    expect(checkout).toContain("Caixa.operationPath('vendas', '/api/caixa/vendas')");
    expect(catalog).toContain('idempotency_key: checkout.idempotencyKey');
    expect(catalog).toContain("fulfillment_mode: 'pickup'");
    expect(catalog).toContain("source_tag: 'walkin_balcao'");
    expect(partnerRoute).toContain("requireScreen('vendas')");
    expect(partnerQueries).toContain('SET operator_token_id = $4');
    expect(partnerQueries).toContain('[orderId, ctx.environment, ctx.unitId, ctx.tokenId]');
  });

  it('permite ao vendedor negociar cada item sem mudar o preço oficial', () => {
    expect(pricing).toContain("label.textContent = 'Preço nesta venda'");
    expect(pricing).toContain('input.maxLength = 12');
    expect(pricing).toContain('line.negotiatedPrice = price');
    expect(pricing).toContain('price <= 0');
    expect(catalog).toContain('unit_price: Number(line.negotiatedPrice)');
    expect(catalog).toContain('reference_unit_price: Number(line.referencePrice)');
    expect(partnerPricing).toContain('partner_sale_price_changed');
    expect(partnerPricing).toContain('FOR UPDATE');
  });

  it('zera o carrinho ao trocar conta ou unidade e ignora respostas da sessão anterior', () => {
    expect(core).toContain('if (Caixa.resetCheckout) Caixa.resetCheckout()');
    expect(core).toContain('Caixa.bindCheckoutSession(sessionFingerprint())');
    expect(core).toContain("window.addEventListener('storage'");
    expect(checkoutSession).toContain('checkout.cart.clear()');
    expect(checkoutSession).toContain("checkout.customerName = 'Cliente Balcão'");
    expect(checkout).toContain('requestSession !== Caixa.sessionFingerprint()');
    expect(checkout).toContain('Caixa.checkoutSessionChanged(saleSession)');
    expect(checkout).toContain("Caixa.showToast('A conta mudou. O carrinho anterior foi limpo.')");
  });
});

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

async function partnerFile(name: string): Promise<string> {
  return readFile(path.join(process.cwd(), 'parceiro', 'public', name), 'utf8');
}

describe('partner checkout layout', () => {
  it('keeps the real sale bindings in the approved three-column composition', async () => {
    const html = await partnerFile('index.html');

    expect(html).toContain("currentSection === 'vendas' && 'checkout-screen'");
    expect(html).toContain('class="pos-panel pos-products"');
    expect(html).toContain('class="pos-panel pos-cart-panel"');
    expect(html).toContain('class="pos-panel pos-payment-panel"');
    expect(html).toContain('class="pos-panel pos-payment-summary"');
    expect(html).toContain('@click="posAddProduct(item)"');
    expect(html).toContain('@click="posFinalizeSale()"');
    expect(html).toContain('x-model="posNotes"');
    expect(html).toContain('x-model="saleForm.source_tag"');
    expect(html).toContain('<span>Origem da compra</span>');
    expect(html).toContain('/admin/painel/assets/catalog-tire.webp');
    expect(html).not.toContain('<summary>Detalhes da venda</summary>');
    expect(html).toContain('value="Retirada (paga agora)"');
  });

  it('does not reintroduce delivery as a checkout fulfillment option', async () => {
    const html = await partnerFile('index.html');
    const checkout = html.split('<section x-show="currentSection === \'vendas\'"')[1]
      ?.split('<!-- KPIs da aba Pedidos')[0] ?? '';

    expect(checkout).not.toContain('value="delivery"');
    expect(checkout).not.toContain('Endereço de entrega');
    expect(checkout).toContain('Retirada (paga agora)');
  });

  it('keeps the checkout content specific while sharing the shell with every tab', async () => {
    const css = await partnerFile('style.css');

    expect(css).toContain('FRENTE DE CAIXA 2026-08-06');
    expect(css).toContain('.checkout-screen .pos-checkout');
    expect(css).toContain('CASCO GLOBAL 2026-08-06');
    expect(css).toContain('FRENTE DE CAIXA 2026-08-06 — detalhes operacionais e leitura dos produtos');
    expect(css).toContain('.pos-shell .pos-sidebar');
    expect(css).toContain('.pos-shell .pos-topbar');
    expect(css).toContain('.pos-tire-thumb.with-image');
    expect(css).toContain('.pos-shell.checkout-screen[data-theme="light"] .pos-customer-inline-form');
    expect(css).toContain('.checkout-screen .pos-inline-save');
    expect(css).toContain('@media (max-width: 768px)');
  });

  it('provides the dedicated employee mobile checkout without changing delivery semantics', async () => {
    const [html, css, app, kpis, pdv] = await Promise.all([
      partnerFile('index.html'),
      partnerFile('style.css'),
      partnerFile('app.js'),
      partnerFile('app.pdv.kpis.js'),
      partnerFile('app.pdv.js'),
    ]);

    expect(html).toContain('class="pos-mobile-checkout-intro"');
    expect(html).toContain('class="pos-mobile-mode-tabs"');
    expect(html).toContain('@click="goToSection(\'entrega\')"');
    expect(html).toContain('class="pos-mobile-category-tabs"');
    expect(html).toContain('class="pos-mobile-current-sale"');
    expect(html).toContain('class="pos-mobile-payments"');
    expect(html).toContain('class="pos-mobile-checkout-bar"');
    expect(html).toContain('x-show="!isMobile || posMobileStep === \'checkout\'"');
    expect(app).toContain("posMobileCategory: 'pneu'");
    expect(app).toContain('mobileMenuOpen: false');
    expect(kpis).toContain("this.posMobileCategory === 'servico'");
    expect(kpis).toContain("this.posMobileCategory === 'outro'");
    expect(pdv).toContain("item_type: item.item_type || 'pneu'");
    expect(css).toContain('FRENTE DE CAIXA MOBILE 2026-08-06');
    expect(css).toContain('.pos-shell.checkout-screen .pos-sidebar.mobile-open');
    expect(css).toContain('.checkout-screen .pos-mobile-checkout-bar');
  });
});

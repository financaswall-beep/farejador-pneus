import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

async function partnerFile(name: string): Promise<string> {
  return readFile(path.join(process.cwd(), 'parceiro', 'public', name), 'utf8');
}

describe('partner delivery mobile layout', () => {
  it('activates the isolated delivery shell and mobile navigation', async () => {
    const html = await partnerFile('index.html');

    expect(html).toContain("currentSection === 'entrega' && 'delivery-screen'");
    expect(html).toContain('class="pos-delivery-mobile-intro"');
    expect(html).toContain('class="pos-delivery-mobile-kpis"');
    expect(html).toContain('class="pos-delivery-mobile-tools"');
    expect(html).toContain('class="pos-delivery-mobile-nav"');
    expect(html).toContain('Buscar cliente ou pedido');
  });

  it('makes the approved product photo unmistakable in the delivery card', async () => {
    const html = await partnerFile('index.html');

    expect(html).toContain('class="pos-route-photo-thumb"');
    expect(html).toContain('FOTO DO PRODUTO');
    expect(html).toContain('Pneu aprovado pelo cliente');
    expect(html).toContain('Toque para ampliar e conferir a peça');
    expect(html).toContain('Este pedido não possui foto vinculada');
  });

  it('keeps the mobile filter and search backed by real delivery data', async () => {
    const deliveries = await partnerFile('app.entregas.js');

    expect(deliveries).toContain("deliveryMobileFilter: 'open'");
    expect(deliveries).toContain("deliverySearch: ''");
    expect(deliveries).toContain('setDeliveryListFilter(filter)');
    expect(deliveries).toContain("haystack.includes(query)");
    expect(deliveries).toContain('deliveryOrderLabel(sale)');
    expect(deliveries).toContain('deliveryPaymentLabel(sale)');
  });

  it('scopes the new composition to mobile delivery only', async () => {
    const css = await partnerFile('style.css');

    expect(css).toContain('ENTREGA MOBILE 2026-08-06');
    expect(css).toContain('@media (max-width: 768px)');
    expect(css).toContain('.pos-shell.delivery-screen .pos-sidebar');
    expect(css).toContain('.pos-shell.delivery-screen .pos-route-card');
    expect(css).toContain('.pos-shell.delivery-screen[data-theme="light"] .pos-route-photo');
  });
});

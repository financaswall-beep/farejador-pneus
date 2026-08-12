import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(file: string): string {
  return readFileSync(resolve(file), 'utf8');
}

describe('Entregas na Operação da Loja', () => {
  const html = source('painel/public/caixa.html');
  const css = source('painel/public/caixa.css');
  const ui = source('painel/public/caixa-deliveries.js');
  const tabs = source('painel/public/caixa-sales.js');
  const modules = source('painel/public/caixa-modules.js');
  const backend = source('src/parceiro/operation-deliveries.ts');
  const route = source('src/parceiro/route-operation-deliveries.ts');
  const appRoutes = source('src/app/routes.ts');
  const staticRoute = source('src/admin/caixa/route-static.ts');

  it('substitui o placeholder por uma tela mobile completa', () => {
    expect(html).toContain('id="deliveries-panel"');
    expect(html).toContain('Pedidos de hoje');
    expect(html).toContain('data-delivery-filter="pending"');
    expect(html).toContain('data-delivery-filter="dispatched"');
    expect(html).toContain('data-delivery-filter="delivered"');
    expect(html).toContain('Buscar cliente ou pedido');
    expect(html).toContain('/caixa/caixa-deliveries.js');
    expect(tabs).not.toContain('será implementada na próxima etapa');
    expect(tabs).toContain("showTab('deliveries')");
    expect(modules).toContain("return 'deliveries'");
    expect(css).toContain('.delivery-status-tabs');
    expect(css).toContain('.delivery-product-visual');
  });

  it('mostra foto identificada, rota, contato e ações de andamento', () => {
    expect(ui).toContain("badge.textContent = 'FOTO DO PRODUTO'");
    expect(ui).toContain("'REFERÊNCIA DO PRODUTO'");
    expect(ui).toContain('https://www.google.com/maps/search/');
    expect(ui).toContain('https://wa.me/');
    expect(ui).toContain("action === 'claim'");
    expect(ui).toContain("action === 'dispatch'");
    expect(ui).toContain("action === 'deliver'");
    expect(ui).toContain('Como o cliente pagou?');
    expect(ui).not.toContain('innerHTML');
  });

  it('mantém a leitura isolada pela unidade e financeiramente cega', () => {
    expect(backend).toContain('pof.environment = $1 AND pof.unit_id = $2');
    expect(backend).toContain("pof.fulfillment_mode = 'delivery'");
    expect(backend).toContain("pof.status <> 'cancelled'");
    expect(backend).toContain('po.unit_id = $3');
    expect(backend).not.toContain('average_cost');
    expect(backend).not.toContain('unit_cost_snapshot');
    expect(backend).not.toContain('finance.');
  });

  it('protege feed e imagem com a permissão Entregas', () => {
    expect(route).toContain("requireScreen('entregas')");
    expect(route).toContain("'/parceiro/:slug/api/operacao/entregas'");
    expect(route).toContain("'/parceiro/:slug/api/operacao/entregas/fotos/:photoRequestId'");
    expect(ui).toContain("Caixa.operationPath('operacao/entregas')");
    expect(appRoutes).toContain('registerPartnerOperationDeliveryRoutes');
    expect(staticRoute).toContain("'/caixa/caixa-deliveries.js'");
  });
});

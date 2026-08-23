import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

function pickupModule() {
  const sandbox: Record<string, any> = { window: {}, lucide: { createIcons() {} } };
  runInNewContext(source('painel/public/app.partner-retiradas.js'), sandbox);
  return sandbox.window.PAINEL_MODULES.partnerRetiradas();
}

describe('retiradas do parceiro no painel único', () => {
  it('publica a tela somente no escopo parceiro e exige a permissão retiradas', () => {
    const nav = source('painel/public/app.nav.js');
    const html = source('painel/public/index.html');
    const staticRoute = source('src/admin/painel/route-static.ts');
    const partnerRoute = source('src/parceiro/route.ts');

    expect(nav).toContain("{ id: 'retiradas', label: 'Retiradas'");
    expect(nav).toContain("scopes: ['partner'], requires: 'retiradas'");
    expect(nav).toContain("partnerLoad: ['loadPartnerRetiradas']");
    expect(html).toContain("currentPage === 'retiradas' && isPartnerPanel()");
    expect(html).toContain('app.partner-retiradas.js?v=20260823-partner-pickups1');
    expect(staticRoute).toContain("'app.partner-retiradas.js'");
    expect(partnerRoute).toContain("fastify.get('/parceiro/:slug/api/retiradas', { preHandler: [requirePartnerAuth, requireScreen('retiradas')] }");
    expect(partnerRoute).toContain("fastify.post('/parceiro/:slug/api/retiradas/:orderId', { preHandler: [requirePartnerAuth, requireScreen('retiradas')] }");
    expect(partnerRoute).toContain("fastify.delete('/parceiro/:slug/api/retiradas/:orderId', { preHandler: [requirePartnerAuth, requireScreen('retiradas')] }");
  });

  it('confirma pelo endpoint escopado e não antecipa cálculo financeiro no navegador', async () => {
    const row = {
      order_id: '11111111-1111-4111-8111-111111111111',
      total_amount: '135.00', fulfillment_mode: 'pickup', awaiting_pickup: true,
    };
    const apiGet = vi.fn()
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] });
    const apiWrite = vi.fn().mockResolvedValue({ retrieved: true });
    const app: any = {
      isPartnerPanel: () => true,
      hasPanelModule: (name: string) => name === 'retiradas',
      partnerApiGet: apiGet,
      partnerApiWrite: apiWrite,
      $nextTick: (callback: () => void) => callback(),
    };
    Object.defineProperties(app, Object.getOwnPropertyDescriptors(pickupModule()));

    await app.loadPartnerRetiradas();
    app.partnerRetiradasSetPayment(row.order_id, 'Dinheiro');
    await app.partnerRetiradasConfirm(row);

    expect(apiWrite).toHaveBeenCalledWith(`retiradas/${row.order_id}`, 'POST', {
      payment_method: 'Dinheiro',
    });
    expect(app.partnerRetiradasRows).toEqual([]);
    expect(app.partnerRetiradasNotice).toContain('estoque e caixa confirmados pelo servidor');
    const moduleSource = source('painel/public/app.partner-retiradas.js');
    expect(moduleSource).not.toMatch(/sales_month\s*[+\-]=|cash_net_month\s*[+\-]=/);
  });

  it('exige motivo no 2W e cancela sem chamar rota de vendas', async () => {
    const row = {
      order_id: '22222222-2222-4222-8222-222222222222',
      source_tag: '2w', total_amount: '90.00',
    };
    const apiWrite = vi.fn().mockResolvedValue({ cancelled: true });
    const app: any = {
      isPartnerPanel: () => true,
      hasPanelModule: () => true,
      partnerApiGet: vi.fn().mockResolvedValue({ rows: [] }),
      partnerApiWrite: apiWrite,
      $nextTick: (callback: () => void) => callback(),
    };
    Object.defineProperties(app, Object.getOwnPropertyDescriptors(pickupModule()));
    app.partnerRetiradasRows = [row];
    app.partnerRetiradasOpenCancel(row);

    await app.partnerRetiradasCancel(row);
    expect(apiWrite).not.toHaveBeenCalled();
    expect(app.partnerRetiradasError).toContain('motivo');

    app.partnerRetiradasCancelReason = 'Cliente não apareceu';
    await app.partnerRetiradasCancel(row);
    expect(apiWrite).toHaveBeenCalledWith(`retiradas/${row.order_id}`, 'DELETE', {
      reason: 'Cliente não apareceu',
    });
    expect(apiWrite.mock.calls[0][0]).not.toContain('vendas');
    expect(app.partnerRetiradasNotice).toContain('sem entrada no caixa');
  });

  it('cliente HTTP restringe método, caminho e token à API do parceiro', () => {
    const api = source('painel/public/app.partner-api.js');
    expect(api).toContain("['GET', 'POST', 'PUT', 'DELETE'].includes(method)");
    expect(api).toContain('partnerApiResourceUrl(resource)');
    expect(api).toContain('Authorization: `Bearer ${this.panelPartnerToken}`');
    expect(api).not.toMatch(/panelPartnerToken[\s\S]{0,120}\/admin\/api/);
  });

  it('mantém a foto como apoio opcional e nunca bloqueia a retirada', () => {
    const moduleSource = source('painel/public/app.partner-retiradas.js');
    expect(moduleSource).toContain("if (this.hasPanelModule('batepapo'))");
    expect(moduleSource).toContain('photo-requests/${photoRequestId}/image');
    expect(moduleSource).toContain('Falha/sem permissão não bloqueia a retirada');
  });
});

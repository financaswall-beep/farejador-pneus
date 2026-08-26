import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

function pickupModule() {
  const sandbox: Record<string, any> = {
    window: {}, lucide: { createIcons() {} }, performance: { now: () => Date.now() },
  };
  runInNewContext(source('painel/public/app.partner-retiradas.js'), sandbox);
  return sandbox.window.PAINEL_MODULES.partnerRetiradas();
}

describe('retiradas no painel único', () => {
  it('publica a mesma tela para Matriz e parceiro, mantendo rotas protegidas', () => {
    const nav = source('painel/public/app.nav.js');
    const html = source('painel/public/index.html');
    const staticRoute = source('src/admin/painel/route-static.ts');
    const partnerRoute = source('src/parceiro/route.ts');
    const matrixRoute = source('src/admin/painel/route-pedidos.ts');
    const matrixModules = source('src/admin/panel-modules.ts');

    expect(nav).toContain("{ id: 'retiradas', label: 'Retiradas'");
    expect(nav).toContain("scopes: ['matrix', 'partner'], requires: 'retiradas'");
    expect(nav).toContain("partnerLoad: ['loadPartnerRetiradas']");
    expect(html).toContain("currentPage === 'retiradas'");
    expect(html).toContain('/admin/painel/tailwind.css?v=20260826-payroll2');
    expect(html).toContain('data-pickup-workspace');
    expect(html).toContain('data-pickup-detail-panel');
    expect(html).toContain('[data-pickup-detail-panel]{position:static!important');
    expect(html).toContain('app.partner-retiradas.js?v=20260824-pickup-cards1');
    expect(staticRoute).toContain("'app.partner-retiradas.js'");
    expect(partnerRoute).toContain("fastify.get('/parceiro/:slug/api/retiradas', { preHandler: [requirePartnerAuth, requireScreen('retiradas')] }");
    expect(partnerRoute).toContain("fastify.post('/parceiro/:slug/api/retiradas/:orderId', { preHandler: [requirePartnerAuth, requireScreen('retiradas')] }");
    expect(partnerRoute).toContain("fastify.put('/parceiro/:slug/api/retiradas/:orderId/stage', { preHandler: [requirePartnerAuth, requireScreen('retiradas')] }");
    expect(partnerRoute).toContain("fastify.delete('/parceiro/:slug/api/retiradas/:orderId', { preHandler: [requirePartnerAuth, requireScreen('retiradas')] }");
    expect(matrixRoute).toContain("fastify.get('/admin/api/retiradas', { preHandler: requireAdminOwner }");
    expect(matrixRoute).toContain("fastify.put('/admin/api/retiradas/:order_id/stage', { preHandler: requireAdminOwner }");
    expect(matrixRoute).toContain("fastify.post('/admin/api/orders/:order_id/retrieve', { preHandler: requireAdminOwner }");
    expect(matrixRoute).toContain('payment_method: z.string().trim().min(1).max(80)');
    expect(partnerRoute).toContain('payment_method: z.string().trim().min(1).max(80)');
    expect(matrixModules).toContain("'retiradas', 'clientes', 'compras'");
    expect(matrixModules).toContain("'colaboradores', 'catalogo'");
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
      partnerPanelTelemetry: vi.fn(),
      partnerPanelErrorCode: () => 'api_error',
      $nextTick: (callback: () => void) => callback(),
    };
    Object.defineProperties(app, Object.getOwnPropertyDescriptors(pickupModule()));

    await app.loadPartnerRetiradas();
    app.partnerRetiradasSetPayment(row.order_id, 'Dinheiro');
    await app.partnerRetiradasConfirm(row);

    expect(apiWrite).toHaveBeenCalledWith(`retiradas/${row.order_id}`, 'POST', {
      payment_method: 'Dinheiro',
      services: [],
    });
    expect(app.partnerRetiradasRows).toEqual([]);
    expect(app.partnerRetiradasNotice).toContain('serviços, estoque e caixa');
    const moduleSource = source('painel/public/app.partner-retiradas.js');
    expect(moduleSource).not.toMatch(/sales_month\s*[+\-]=|cash_net_month\s*[+\-]=/);
  });

  it('exige motivo e cancela sem chamar rota de vendas', async () => {
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
      partnerPanelTelemetry: vi.fn(),
      partnerPanelErrorCode: () => 'api_error',
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
    expect(api).toContain("['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)");
    expect(api).toContain('partnerApiResourceUrl(resource)');
    expect(api).toContain('Authorization: `Bearer ${this.panelPartnerToken}`');
    expect(api).not.toMatch(/panelPartnerToken[\s\S]{0,120}\/admin\/api/);
  });

  it('mantém a foto como apoio opcional e nunca bloqueia a retirada', () => {
    const moduleSource = source('painel/public/app.partner-retiradas.js');
    expect(moduleSource).toContain("this.hasPanelModule('batepapo')");
    expect(moduleSource).toContain('photo-requests/${photoRequestId}/image');
    expect(moduleSource).toContain('Falha/sem permissão não bloqueia a retirada');
  });

  it('envia etapas e serviços em centavos sem alterar o total local persistido', async () => {
    const row = { order_id: '33333333-3333-4333-8333-333333333333', total_amount: '89.00' };
    const apiWrite = vi.fn().mockResolvedValue({ stage: 'arrived' });
    const app: any = {
      isPartnerPanel: () => true, hasPanelModule: () => true,
      partnerApiWrite: apiWrite, partnerApiGet: vi.fn().mockResolvedValue({ rows: [row],
        service_catalog: [{ code: 'mounting', label: 'Montagem do pneu' }] }),
      partnerPanelTelemetry: vi.fn(), partnerPanelErrorCode: () => 'api_error',
      $nextTick: (callback: () => void) => callback(),
    };
    Object.defineProperties(app, Object.getOwnPropertyDescriptors(pickupModule()));
    await app.loadPartnerRetiradas();
    app.partnerRetiradasAddService(row);
    app.partnerRetiradasSetServiceMode(row, 0, 'charged');
    app.partnerRetiradasSetServiceAmount(row, 0, '20,00');
    expect(app.partnerRetiradasGrandTotal(row)).toBe(109);
    expect(row.total_amount).toBe('89.00');
    await app.partnerRetiradasStageSave(row, 'arrived');
    expect(apiWrite).toHaveBeenCalledWith(`retiradas/${row.order_id}/stage`, 'PUT', {
      stage: 'arrived', services: [{ code: 'mounting', charge_mode: 'charged', amount_cents: 2000 }],
    });
  });

  it('não soma serviço duas vezes após concluir e mantém Chegaram hoje causal', () => {
    const app: any = {};
    Object.defineProperties(app, Object.getOwnPropertyDescriptors(pickupModule()));
    const now = new Date().toISOString();
    const completed = {
      order_id: '44444444-4444-4444-8444-444444444444',
      status: 'paid', awaiting_pickup: false, retrieved_at: now,
      pickup_arrived_at: now, total_amount: '109.00',
    };
    const installing = {
      order_id: '55555555-5555-4555-8555-555555555555',
      pickup_arrived_at: now, pickup_installation_started_at: now,
    };
    app.partnerRetiradasRows = [completed, installing];
    app.partnerRetiradasServices = {
      [completed.order_id]: [{ code: 'mounting', charge_mode: 'charged', amount_cents: 2000 }],
    };

    expect(app.partnerRetiradasGrandTotal(completed)).toBe(109);
    expect(app.partnerRetiradasSummary.arrived).toBe(2);
    expect(app.partnerRetiradasStepReached(installing, 'arrived')).toBe(true);
    expect(app.partnerRetiradasStepReached(installing, 'payment')).toBe(true);
    expect(app.partnerRetiradasStepReached(installing, 'installing')).toBe(true);
    expect(app.partnerRetiradasStepReached(installing, 'completed')).toBe(false);
  });

  it('apresenta etapas numeradas com ícones, logos das marcas e WhatsApp nos cards web', async () => {
    const html = source('painel/public/index.html');
    const row = { items: [
      { quantity: 1, tire_size: '90/90-18', brand: 'Pirelli' },
      { quantity: 2, tire_size: '80/100-14', brand: 'Marca futura' },
      { quantity: 1, item_name: 'Montagem', pickup_service_code: 'mounting' },
    ] };
    const app: any = {
      catalogoBrandLogo: (brand: string) => brand === 'Pirelli' ? '/pirelli.webp' : null,
      isPartnerPanel: () => false, hasPanelModule: () => true,
      apiGet: vi.fn().mockResolvedValue({ rows: [row], service_catalog: [] }),
      $nextTick: (callback: () => void) => callback(),
    };
    Object.defineProperties(app, Object.getOwnPropertyDescriptors(pickupModule()));
    await app.loadPartnerRetiradas();

    expect(app.partnerRetiradasRows[0].pickup_card_items).toEqual([
      expect.objectContaining({ pickup_label: '1× 90/90-18', pickup_brand_logo: '/pirelli.webp' }),
      expect.objectContaining({ pickup_label: '2× 80/100-14', pickup_brand_logo: null }),
    ]);
    expect(app.partnerRetiradasItemsLabel(row)).toBe('1× 90/90-18 Pirelli · 2× 80/100-14 Marca futura');
    expect(html).toContain('data-pickup-card-actions');
    expect(html).toContain('data-pickup-brand-logo');
    expect(html).toContain('data-pickup-step-number>1</b>Chegou');
    expect(html).toContain('data-lucide="wallet-cards"');
    expect(html).not.toContain('absolute -right-1 -top-1');
    expect(html).toContain('item.pickup_brand_logo');
    expect(html).toContain('partnerRetiradasWaLink(row)');
    expect(html).toContain('Sem WhatsApp');
    expect(html).toContain('Abrir atendimento');
  });

  it('Vendas apenas encaminha a retirada para o fluxo único', () => {
    const varejo = source('painel/public/app.varejo.js');
    expect(varejo).toContain("this.currentPage = 'retiradas'");
    expect(varejo).not.toContain("apiPost(`/admin/api/orders/${row.id}/retrieve`, {})");
    expect(source('painel/public/index.html')).toContain('Abrir em Retiradas');
  });
});

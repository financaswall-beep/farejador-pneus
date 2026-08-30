import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

function stockModule() {
  const sandbox: Record<string, any> = {
    window: {}, lucide: { createIcons() {} },
    performance: { now: () => 10 },
    crypto: { randomUUID: () => '11111111-1111-4111-8111-111111111111' },
    encodeURIComponent,
  };
  runInNewContext(source('painel/public/app.partner-estoque.js'), sandbox);
  return sandbox.window.PAINEL_MODULES.partnerEstoque();
}

function appWith(module: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  const app: any = {
    isPartnerPanel: () => true,
    hasPanelModule: (name: string) => name === 'estoque',
    partnerApiGet: vi.fn(), partnerApiWrite: vi.fn(),
    partnerPanelTelemetry: vi.fn(), partnerPanelErrorCode: () => 'api_error',
    $nextTick: (callback: () => void) => callback(),
    ...overrides,
  };
  Object.defineProperties(app, Object.getOwnPropertyDescriptors(module));
  return app;
}

describe('estoque do parceiro no painel único', () => {
  it('habilita a página para parceiro e preserva o galpão exclusivo da Matriz', () => {
    const nav = source('painel/public/app.nav.js');
    const html = source('painel/public/index.html');
    const staticRoute = source('src/admin/painel/route-static.ts');

    expect(nav).toContain("scopes: ['matrix', 'partner'], requires: 'estoque'");
    expect(nav).toContain("partnerLoad: ['loadPartnerEstoque']");
    expect(html).toContain("currentPage === 'estoque' && isPartnerPanel()");
    expect(html).toContain("currentPage === 'estoque' && isMatrixPanel()");
    expect(html).toContain('app.partner-estoque.js?v=20260829-partner-stock3');
    expect(html).toContain('app.partner-estoque.actions.js?v=20260829-partner-stock3');
    expect(html).toContain('Buscar medida ou marca');
    expect(html).toContain('Controle o saldo, as reservas e as entradas da sua unidade');
    expect(html).toContain('Estoque físico');
    expect(html).toContain('Pneus da unidade');
    expect(html).toContain('Novo pneu');
    expect(html).toContain('Corrigir saldo');
    expect(html).toContain('Alterar preço');
    expect(html).toContain('data-partner-stock-kpis');
    expect(html).toContain('data-partner-stock-workspace');
    expect(html).toContain('data-partner-stock-main');
    expect(html).toContain('data-partner-stock-sidebar');
    expect(html).toContain('[data-partner-stock-workspace]{display:grid;grid-template-columns:minmax(0,1fr)');
    expect(html).toContain('[data-partner-stock-workspace]{grid-template-columns:minmax(0,2fr) minmax(340px,1fr)!important}');
    expect(html).not.toContain('O bot consulta este saldo');
    expect(staticRoute).toContain("'app.partner-estoque.js'");
    expect(staticRoute).toContain("'app.partner-estoque.actions.js'");
  });

  it('carrega a fonte operacional escopada e calcula apenas indicadores visuais', async () => {
    const rows = [
      { stock_id: 'a', item_type: 'pneu', item_name: '90/90-18', tire_size: '90/90-18',
        quantity_on_hand: 10, quantity_reserved: 2, quantity_available: 8, stock_status: 'in_stock' },
      { stock_id: 'b', item_type: 'pneu', item_name: '130/70-17', tire_size: '130/70-17',
        quantity_on_hand: 3, quantity_reserved: 3, quantity_available: 0, stock_status: 'reserved' },
      { stock_id: 'c', item_type: 'servico', item_name: 'Montagem', quantity_on_hand: null,
        quantity_reserved: 0, quantity_available: null, stock_status: 'untracked' },
    ];
    const apiGet = vi.fn().mockResolvedValue({
      rows, pending: { item_registrations: 1, stock_counts: 2 },
    });
    const app = appWith(stockModule(), { partnerApiGet: apiGet });

    await app.loadPartnerEstoque();

    expect(apiGet).toHaveBeenCalledWith('operacao/estoque');
    expect(app.partnerPanelTelemetry).toHaveBeenCalledWith(expect.objectContaining({
      page: 'estoque', event_type: 'read', operation: 'load_stock', outcome: 'success',
    }));
    expect(app.partnerEstoqueSummary()).toEqual({
      items: 2, onHand: 13, reserved: 5, available: 8, low: 1,
    });
    app.partnerEstoque.filtro = 'reservados';
    expect(app.partnerEstoqueFiltered().map((row: any) => row.stock_id)).toEqual(['a', 'b']);
    app.partnerEstoque.filtro = 'sem_saldo';
    expect(app.partnerEstoqueFiltered().map((row: any) => row.stock_id)).toEqual(['b']);
    app.partnerEstoque.filtro = 'todos';
    app.partnerEstoque.busca = 'montagem';
    expect(app.partnerEstoqueFiltered()).toEqual([]);
  });

  it('abre histórico pela mesma API e nunca envia token para rota administrativa', async () => {
    const row = { stock_id: '11111111-1111-4111-8111-111111111111', item_name: 'Pneu' };
    const apiGet = vi.fn().mockResolvedValue({
      stock: { ...row, sale_price: '89.00' },
      history: { rows: [{ id: 'event-1', kind: 'sale', quantity_delta: -1 }], total: 1, has_more: false },
    });
    const app = appWith(stockModule(), { partnerApiGet: apiGet });

    await app.partnerEstoqueOpen(row);

    expect(apiGet).toHaveBeenCalledWith(`operacao/estoque/${row.stock_id}?page=1&limit=20`);
    expect(app.partnerEstoque.history).toHaveLength(1);
    const moduleSource = source('painel/public/app.partner-estoque.js');
    expect(moduleSource).not.toContain('/admin/api');
    expect(moduleSource).not.toContain('average_cost');
    expect(moduleSource).not.toContain('unit_cost');
  });

  it('impede contagem abaixo da reserva e envia a válida para aprovação', async () => {
    const row = {
      stock_id: '11111111-1111-4111-8111-111111111111', item_name: 'Pneu',
      quantity_on_hand: 5, quantity_reserved: 2,
    };
    const apiWrite = vi.fn().mockResolvedValue({ id: 'request-1', status: 'pending' });
    const apiGet = vi.fn().mockResolvedValue({ rows: [row], pending: { item_registrations: 0, stock_counts: 1 } });
    const app = appWith(stockModule(), { partnerApiWrite: apiWrite, partnerApiGet: apiGet });
    app.partnerEstoqueOpenCount(row);
    app.partnerEstoque.count.quantity = 1;

    await app.partnerEstoqueSubmitCount();
    expect(apiWrite).not.toHaveBeenCalled();
    expect(app.partnerEstoque.count.error).toContain('reservado');

    app.partnerEstoque.count.quantity = 3;
    app.partnerEstoque.count.reason = 'inventario';
    await app.partnerEstoqueSubmitCount();

    expect(apiWrite).toHaveBeenCalledWith('operacao/estoque/contagens', 'POST', {
      stock_id: row.stock_id, counted_quantity: 3, reason: 'inventario', reason_detail: null,
      idempotency_key: 'panel-count-11111111-1111-4111-8111-111111111111',
    });
    expect(app.partnerPanelTelemetry).toHaveBeenCalledWith(expect.objectContaining({
      page: 'estoque', event_type: 'write', operation: 'request_stock_count', outcome: 'success',
    }));
    expect(app.partnerEstoque.notice).toContain('aprovação');
  });

  it('leva a entrada para Compras e mantém o Catálogo separado do saldo', () => {
    const partnerComprasNew = vi.fn();
    const loadPartnerCatalogo = vi.fn();
    const app = appWith(stockModule(), {
      panelWorkplace: { role: 'owner' }, currentPage: 'estoque', partnerComprasNew,
      loadPartnerCatalogo,
      hasPanelModule: (name: string) => ['estoque', 'compras', 'catalogo'].includes(name),
    });

    app.partnerEstoqueOpenEntry();
    expect(app.currentPage).toBe('compras');
    expect(partnerComprasNew).toHaveBeenCalledTimes(1);

    app.partnerEstoqueOpenCatalog();
    expect(app.currentPage).toBe('catalogo');
    expect(loadPartnerCatalogo).toHaveBeenCalledWith(1);
  });

  it('mantém consulta e mutação escopadas por unidade no servidor', () => {
    const query = source('src/parceiro/operation-stock.ts');
    const detail = source('src/parceiro/operation-stock-detail.ts');
    const route = source('src/parceiro/route-operation-stock.ts');

    expect(query).toContain('withPartnerContext(ctx.partnerUnitId');
    expect(query).toContain('WHERE environment=$1 AND unit_id=$2');
    expect(query).toContain('product_id, local_sku');
    expect(query).not.toContain('sale_price');
    expect(detail).toContain('WHERE id=$1 AND environment=$2 AND unit_id=$3');
    expect(route).toContain("const stockScreen = [requirePartnerAuth, requireScreen('estoque')]");
    expect(route).toContain("fastify.post('/parceiro/:slug/api/operacao/estoque/contagens'");
    const canaryRoute = source('src/parceiro/route-panel-canary.ts');
    const canaryMigration = source('db/migrations/0205_partner_stock_panel_canary.sql');
    expect(canaryRoute).toContain("page: z.enum(['resumo', 'retiradas', 'estoque'])");
    expect(canaryRoute).toContain("'load_stock', 'load_stock_detail', 'request_stock_count'");
    expect(canaryMigration).toContain("CHECK (page IN ('resumo','retiradas','estoque'))");
  });
});

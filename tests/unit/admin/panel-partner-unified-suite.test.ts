import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

function factory(file: string, name: string) {
  const sandbox: Record<string, any> = {
    window: {}, encodeURIComponent, Intl, Date,
    crypto: { randomUUID: () => '11111111-1111-4111-8111-111111111111' },
    lucide: { createIcons() {} },
  };
  runInNewContext(source(file), sandbox, { filename: file });
  return sandbox.window.PAINEL_MODULES[name]();
}

function appWith(module: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  const app: any = {
    isPartnerPanel: () => true,
    hasPanelModule: () => true,
    panelWorkplace: { role: 'owner' },
    partnerApiGet: vi.fn(), partnerApiWrite: vi.fn(),
    businessFactInstant: (date: string) => date ? `${date}T12:00:00-03:00` : null,
    $nextTick: (callback: () => void) => callback(),
    ...overrides,
  };
  Object.defineProperties(app, Object.getOwnPropertyDescriptors(module));
  return app;
}

describe('painel único completo da unidade parceira', () => {
  it('habilita as sete áreas sem habilitar Marketing, Bot ou Rede', () => {
    const nav = source('painel/public/app.nav.js');
    const api = source('painel/public/app.partner-api.js');
    const html = source('painel/public/index.html');
    const staticRoute = source('src/admin/painel/route-static.ts');
    const assembly = source('painel/public/app.montagem.js');

    for (const [page, loader] of [
      ['vendas', 'loadPartnerVendas'], ['compras', 'loadPartnerCompras'],
      ['estoque', 'loadPartnerEstoque'], ['logistica', 'loadPartnerLogistica'],
      ['financeiro', 'loadPartnerFinanceiro'],
      ['colaboradores', 'loadPartnerColaboradores'],
      ['catalogo', 'loadPartnerCatalogo'],
    ]) {
      expect(nav).toContain(`partnerLoad: ['${loader}']`);
      expect(html).toContain(`currentPage === '${page}' && isPartnerPanel()`);
      expect(html).toContain(`currentPage === '${page}' && isMatrixPanel()`);
      expect(staticRoute).toContain(`'app.partner-${page}.js'`);
      expect(assembly).toContain(`PAINEL_MODULES.partner${page[0].toUpperCase()}${page.slice(1)}`);
    }

    expect(html).toContain('app.partner-compras.receipt.js');
    expect(staticRoute).toContain("'app.partner-compras.receipt.js'");
    expect(assembly).toContain('PAINEL_MODULES.partnerComprasReceipt');

    expect(api).toContain("me.permissions.entregas === true");
    expect(api).toContain("['logistica']");
    expect(api).not.toContain("me.permissions.financeiro === true");
    expect(api).not.toMatch(/partnerOnlyModules\.push\([^\n]*(?:marketing|bot|rede)/i);
    for (const blocked of ['bot', 'marketing', 'rede']) {
      expect(nav).toMatch(new RegExp(`${blocked}: \\{ scopes: \\[\\'matrix\\'\\]`));
    }
  });

  it('fecha R$ 135,02 exatamente e registra entrega sem fingir caixa recebido', async () => {
    const write = vi.fn().mockResolvedValue({ created: true });
    const app = appWith(factory(
      'painel/public/app.partner-vendas.js', 'partnerVendas',
    ), { partnerApiWrite: write });
    app.loadPartnerVendas = vi.fn().mockResolvedValue(undefined);
    app.partnerVendasNew();
    app.partnerVendasAdd({
      stock_id: 'a', item_name: 'Pneu A', tire_size: '130/70-13', brand: 'Levorin',
      item_type: 'pneu', quantity_on_hand: 14, quantity_reserved: 0, sale_price: 45.01,
    });
    app.partnerVendas.form.items[0].quantity = 2;
    app.partnerVendasAdd({
      stock_id: 'b', item_name: 'Pneu B', tire_size: '90/90-18', brand: 'Technic',
      item_type: 'pneu', quantity_on_hand: 9, quantity_reserved: 0, sale_price: 45,
    });
    expect(app.partnerVendasTotalCents()).toBe(13_502);

    app.partnerVendasSetFulfillment('delivery');
    app.partnerVendas.form.delivery_address = 'Rua do Cliente, 10';
    await app.partnerVendasSubmit();

    expect(write).toHaveBeenCalledWith('vendas', 'POST', expect.objectContaining({
      fulfillment_mode: 'delivery', payment_status: 'receivable',
      payment_method: null, received_amount: null,
      items: [
        expect.objectContaining({ partner_stock_id: 'a', quantity: 2, unit_price: 45.01 }),
        expect.objectContaining({ partner_stock_id: 'b', quantity: 1, unit_price: 45 }),
      ],
    }));
  });

  it('recusa custo em branco, mantém centavos e separa compra de recebimento físico', async () => {
    const write = vi.fn().mockResolvedValue({ created: true });
    const app = appWith(factory(
      'painel/public/app.partner-compras.js', 'partnerCompras',
    ), { partnerApiWrite: write });
    app.loadPartnerCompras = vi.fn().mockResolvedValue(undefined);
    app.partnerComprasNew();
    const item = app.partnerCompras.form.items[0];
    item.item_name = 'Pneu usado';
    item.tire_size = '90/90-18';
    item.brand = 'Levorin';
    item.tire_condition = 'meia_vida';
    item.quantity = 15;
    expect(app.partnerComprasTotalCents()).toBeNull();
    expect(app.partnerComprasValidation()).toContain('custos');

    item.unit_cost = '15,01';
    item.sale_price = '45,02';
    expect(app.partnerComprasTotalCents()).toBe(22_515);
    await app.partnerComprasSubmit();

    expect(write).toHaveBeenCalledWith('compras', 'POST', expect.objectContaining({
      payment_status: 'paid_now',
      items: [expect.objectContaining({
        quantity: 15, unit_cost: 15.01, sale_price: 45.02,
      })],
    }));
    const payload = write.mock.calls[0]?.[2];
    expect(payload).not.toHaveProperty('receipt_status');
    expect(payload).not.toHaveProperty('quantity_on_hand');
  });

  it('recebe no painel pelo mesmo endpoint da operação e respeita o acerto da Matriz', async () => {
    const write = vi.fn().mockResolvedValue({ received: true });
    const app = appWith(factory(
      'painel/public/app.partner-compras.js', 'partnerCompras',
    ), { partnerApiWrite: write });
    Object.defineProperties(app, Object.getOwnPropertyDescriptors(factory(
      'painel/public/app.partner-compras.receipt.js', 'partnerComprasReceipt',
    )));
    app.loadPartnerCompras = vi.fn().mockResolvedValue(undefined);
    const matrix = {
      id: '30000000-0000-4000-8000-000000000003', receipt_status: 'pending',
      source_wholesale_order_id: '40000000-0000-4000-8000-000000000004',
      matrix_arrival_settled: false,
      items: [{ item_id: '50000000-0000-4000-8000-000000000005', quantity: 8,
        confirmed_quantity: null }],
    };
    app.partnerCompras.rows = [matrix];
    expect(app.partnerComprasCanReceive(matrix)).toBe(false);

    matrix.matrix_arrival_settled = true;
    matrix.items[0].confirmed_quantity = 6;
    app.partnerComprasOpenReceipt(matrix);
    app.partnerComprasReceipt.confirmed = true;
    await app.partnerComprasConfirmReceipt();

    expect(write).toHaveBeenCalledWith(
      `operacao/compras/${matrix.id}/receber`, 'POST', expect.objectContaining({
        items: [{ item_id: matrix.items[0].item_id, received_quantity: 6 }],
      }),
    );
    expect(app.partnerCompras.notice).toContain('estoque da unidade foi atualizado');
  });

  it('libera a leitura de compras para Compras ou Financeiro sem abrir a escrita', () => {
    const route = source('src/parceiro/route.ts');
    expect(route).toContain("requireAnyScreen('compras', 'financeiro')");
    expect(route).toContain("api/compras', { preHandler: comprasReadScreen }");
    expect(route).toContain("api/compras', { preHandler: ownerOnly }");
    expect(route).toContain("api/compras/:purchaseId', { preHandler: ownerOnly }");
  });

  it('não expõe custo nos produtos/vendas e limita todos os adaptadores ao cliente parceiro', () => {
    const query = source('src/parceiro/queries.ts');
    expect(query).toContain("item - 'unit_cost_snapshot' - 'cost_status'");
    const productsSelect = query.slice(
      query.indexOf('export async function getPartnerProdutos'),
      query.indexOf('export async function', query.indexOf('export async function getPartnerProdutos') + 30),
    );
    expect(productsSelect).not.toContain('average_cost');
    for (const page of [
      'vendas', 'compras', 'estoque', 'logistica',
      'financeiro', 'colaboradores', 'catalogo',
    ]) {
      const code = source(`painel/public/app.partner-${page}.js`);
      expect(code).not.toContain('/admin/api');
      expect(code).not.toMatch(/\bthis\.api(?:Get|Post|Put|Delete)\s*\(/);
      expect(code.split(/\r?\n/).length).toBeLessThanOrEqual(300);
    }
    const receipt = source('painel/public/app.partner-compras.receipt.js');
    expect(receipt).not.toContain('/admin/api');
    expect(receipt.split(/\r?\n/).length).toBeLessThanOrEqual(300);
  });

  it('registra catálogo com permissão própria e limita a migration às duas leituras técnicas', () => {
    const routeRoot = source('src/parceiro/route.ts');
    const route = source('src/parceiro/route-panel-catalog.ts');
    const migration = source('db/migrations/0206_partner_panel_catalog_read_grants.sql');
    const grants = JSON.parse(source('scripts/baseline-grants-parceiro.json'));
    expect(routeRoot).toContain("import { registerPartnerPanelCatalogRoutes } from './route-panel-catalog.js'");
    expect(routeRoot).toContain('registerPartnerPanelCatalogRoutes(fastify)');
    expect(route).toContain("const catalogScreen = [requirePartnerAuth, requireScreen('catalogo')]");
    expect(route.match(/preHandler: catalogScreen/g)).toHaveLength(2);
    expect(migration).toContain('ON commerce.vehicle_models, commerce.vehicle_fitments');
    expect(migration).toContain('TO farejador_partner_app');
    expect(migration).toContain("has_table_privilege('farejador_partner_app', relation_name, 'SELECT')");
    expect(migration).toContain("'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'");
    expect(migration).not.toMatch(/commerce\.(wholesale_stock|partner_stock_levels|matriz_product_prices|product_prices)/);
    expect(grants.expected_count).toBe(73);
    expect(grants.grants).toEqual(expect.arrayContaining([
      'commerce.vehicle_models:SELECT:NO',
      'commerce.vehicle_fitments:SELECT:NO',
    ]));
    expect(createHash('sha256').update([...grants.grants].sort().join('\n'), 'utf8').digest('hex'))
      .toBe(grants.expected_sha256);
  });
});

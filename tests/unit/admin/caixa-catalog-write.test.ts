import Fastify, { type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaixaAuth } from '../../../src/admin/caixa/queries.js';
const mocks = vi.hoisted(() => ({ overview: vi.fn(), create: vi.fn(), fromStock: vi.fn(), spec: vi.fn(),
  price: vi.fn(), add: vi.fn(), remove: vi.fn(), compatibility: vi.fn(), applications: vi.fn(), search: vi.fn() }));
vi.mock('../../../src/shared/config/env.js', () => ({ env: { FAREJADOR_ENV: 'test' } }));
vi.mock('../../../src/persistence/db.js', () => ({ pool: {} }));
vi.mock('../../../src/admin/painel/queries-catalogo.js', () => ({ getCatalogOverview: mocks.overview, setCatalogPrice: mocks.price }));
vi.mock('../../../src/admin/painel/queries-catalogo-create.js', () => ({ createCatalogProduct: mocks.create, createCatalogProductFromStock: mocks.fromStock }));
vi.mock('../../../src/admin/painel/queries-catalogo-spec.js', () => ({ updateCatalogTireSpec: mocks.spec }));
vi.mock('../../../src/admin/painel/queries-catalogo-compatibilidade.js', () => ({ getCatalogCompatibility: mocks.compatibility,
  getCatalogMeasureApplications: mocks.applications, searchCatalogVehicleModels: mocks.search,
  addCatalogCompatibility: mocks.add, removeCatalogCompatibility: mocks.remove }));
import { registerCaixaOperationStockRoutes } from '../../../src/admin/caixa/route-operation-stock.js';
import { getMatrizOperationCatalog } from '../../../src/admin/caixa/operation-catalog.js';

describe('cadastro central pela sessão do app', () => {
  let app: ReturnType<typeof Fastify>;
  const base = '/api/caixa/operacao/catalogo', id = '11111111-1111-4111-8111-111111111111';
  const product = { measure: '90/90-18', brand: 'Technic', tire_condition: 'novo',
    product_code: 'TEC-909018', product_name: 'Pneu Technic', creation_mode: 'manual', price_amount: 100 };
  beforeEach(async () => {
    vi.resetAllMocks(); app = Fastify();
    registerCaixaOperationStockRoutes(app, async () => {}, async (req, reply) => {
      if (!req.headers.authorization) { await reply.code(401).send({ error: 'unauthorized' }); return; }
      (req as FastifyRequest & { caixa: Partial<CaixaAuth> }).caixa = { panelRole: req.headers.authorization === 'owner' ? 'owner' : 'admin', displayName: 'Maria', username: 'maria' };
    }, async (req, reply) => { if (req.headers['x-stock'] !== 'yes') await reply.code(403).send({ error: 'module_forbidden' }); });
    await app.ready();
  });
  afterEach(async () => app.close());
  const headers = { authorization: 'owner', 'x-stock': 'yes' };
  it('protege consulta e mutações com autenticação, módulo e papel de proprietário', async () => {
    expect((await app.inject({ url: base })).statusCode).toBe(401);
    expect((await app.inject({ url: base, headers: { authorization: 'owner' } })).statusCode).toBe(403);
    for (const url of ['/products', '/' + id + '/spec', '/' + id + '/price', '/' + id + '/compatibility']) {
      expect((await app.inject({ method: 'POST', url: base + url, headers: { ...headers, authorization: 'admin' }, payload: product })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'DELETE', url: base + '/' + id + '/compatibility/' + id + '/rear', headers: { ...headers, authorization: 'admin' }, payload: { reason: 'conferência' } })).statusCode).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.add).not.toHaveBeenCalled(); expect(mocks.remove).not.toHaveBeenCalled();
  });
  it('reutiliza a criação do web e atribui auditoria à sessão, rejeitando estoque e custo no corpo', async () => {
    mocks.create.mockResolvedValue({ product_id: id });
    expect((await app.inject({ method: 'POST', url: base + '/products', headers, payload: product })).statusCode).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ measure: '90/90-18', priceAmount: 100, actorLabel: 'Caixa: Maria (maria)' }));
    expect((await app.inject({ method: 'POST', url: base + '/products', headers, payload: { ...product, quantity: 10, unit_cost: 50 } })).statusCode).toBe(400);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
  it('não ignora preço no cadastro a partir do estoque e mantém conflitos identificáveis', async () => {
    expect((await app.inject({ method: 'POST', url: base + '/products', headers, payload: { ...product, creation_mode: 'stock' } })).json().error).toBe('catalog_stock_price_after_creation');
    expect(mocks.fromStock).not.toHaveBeenCalled();
    mocks.fromStock.mockResolvedValue({ product_id: id });
    expect((await app.inject({ method: 'POST', url: base + '/products', headers, payload: { ...product, creation_mode: 'stock', price_amount: null } })).statusCode).toBe(201);
    mocks.create.mockRejectedValue(new Error('catalog_variant_already_exists'));
    expect((await app.inject({ method: 'POST', url: base + '/products', headers, payload: product })).statusCode).toBe(409);
  });
  it('lista inclusive produtos sem estoque e transmite somente os campos operacionais', async () => {
    mocks.overview.mockResolvedValue({ brands: ['Technic'], rows: [{ product_id: id, catalogued: true,
      tire_size: '90/90-18', price_amount: 100, official_quantity_on_hand: 0, official_unit_cost: 50,
      gross_profit: 50, margin_percent: 50, last_purchase_cost: 50, nested_secret: { cost: 50 } }] });
    const result = await getMatrizOperationCatalog();
    expect(result.rows[0]).toMatchObject({ product_id: id, local_quantity_available: 0, local_sale_price_min: 100 });
    expect(JSON.stringify(result)).not.toMatch(/unit_cost|gross_profit|margin_percent|last_purchase_cost|nested_secret/);
  });
  it('edita ficha e preço pelas mesmas funções auditadas, preservando os campos omitidos', async () => {
    mocks.spec.mockResolvedValue({ changed: true }); mocks.price.mockResolvedValue({ changed: true });
    const send = (suffix: string, payload: object) => app.inject({ method: 'POST', url: base + '/' + id + suffix, headers, payload });
    expect((await send('/spec', { vehicle_type: 'car', load_index: '91', reason: 'Conferência' })).statusCode).toBe(200);
    expect(mocks.spec).toHaveBeenCalledWith(expect.objectContaining({ productId: id, vehicleType: 'car', loadIndex: '91', position: undefined, actorLabel: 'Caixa: Maria (maria)' }));
    expect((await send('/price', { price_amount: 120.9, reason: 'Tabela' })).statusCode).toBe(200);
    expect(mocks.price).toHaveBeenCalledWith(expect.objectContaining({ productId: id, priceAmount: 120.9, reason: 'Tabela' }));
    expect((await send('/price', { price_amount: 120.999, reason: 'Tabela' })).statusCode).toBe(400);
    expect((await send('/spec', { unit_cost: 10, reason: 'Conferência' })).statusCode).toBe(400);
  });
  it('valida anos e encaminha inclusões e remoções para as regras centrais de compatibilidade', async () => {
    mocks.add.mockResolvedValue({ changed: true }); mocks.remove.mockResolvedValue({ changed: true });
    const payload = { vehicle_model_id: id, position: 'rear', year_start: 2020, year_end: 2024, is_oem: true, source: 'manufacturer', reason: 'Manual conferido' };
    const url = base + '/' + id + '/compatibility';
    expect((await app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(201);
    expect(mocks.add).toHaveBeenCalledWith(expect.objectContaining({ productId: id, vehicleModelId: id, position: 'rear', yearStart: 2020, yearEnd: 2024, isOem: true, source: 'manufacturer' }));
    expect((await app.inject({ method: 'POST', url, headers, payload: { ...payload, year_end: 2019 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: url + '/' + id + '/rear', headers, payload: { reason: 'Correção' } })).statusCode).toBe(200);
    expect(mocks.remove).toHaveBeenCalledWith(expect.objectContaining({ productId: id, vehicleModelId: id, position: 'rear', reason: 'Correção' }));
  });
});

import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
const svc = vi.hoisted(() => ({ read: vi.fn(), create: vi.fn(), edit: vi.fn(), inventory: vi.fn(), models: vi.fn() }));
vi.mock('../../../src/admin/auth.js', () => ({
  requireAdminAuth: async (r: any, p: any) => { if (!r.headers.authorization) return p.code(401).send({ error: 'auth' }); },
  requireAdminOwner: async (r: any, p: any) => { if (r.headers.authorization !== 'owner') return p.code(403).send({ error: 'owner' }); },
}));
vi.mock('../../../src/shared/config/env.js', () => ({ env: { FAREJADOR_ENV: 'test' } }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { error: vi.fn() } }));
vi.mock('../../../src/admin/painel/route-helpers.js', () => ({ operatorLabel: () => 'owner:test' }));
vi.mock('../../../src/admin/painel/queries-catalogo.js', () => ({
  getCatalogOverview: svc.read, getCatalogPriceHistory: vi.fn(), setCatalogPrice: vi.fn(),
}));
vi.mock('../../../src/admin/painel/queries-catalogo-create.js', () => ({
  createCatalogProduct: svc.create, createCatalogProductFromStock: svc.create,
}));
vi.mock('../../../src/admin/painel/queries-catalogo-spec.js', () => ({ updateCatalogTireSpec: svc.edit }));
vi.mock('../../../src/admin/painel/catalog-vehicle-inventory.js', () => ({ getCatalogVehicleInventory: svc.inventory }));
vi.mock('../../../src/admin/painel/queries-catalogo-compatibilidade.js', () => ({
  addCatalogCompatibility: vi.fn(), createCatalogFitmentDiscovery: vi.fn(), getCatalogFitmentDiscoveries: vi.fn(),
  getCatalogCompatibility: vi.fn(), getCatalogMeasureApplications: vi.fn(), removeCatalogCompatibility: vi.fn(),
  reviewCatalogFitmentDiscovery: vi.fn(), searchCatalogVehicleModels: svc.models,
}));
import { registerPainelCatalogo } from '../../../src/admin/painel/route-catalogo.js';

describe('categoria no contrato do catálogo', () => {
  it('valida filtros e mantém todos como padrão, sem permitir escolher outro ambiente', async () => {
    const app = Fastify(); await registerPainelCatalogo(app);
    svc.read.mockResolvedValue({ rows: [], summary: {} });
    expect((await app.inject({ url: '/admin/api/catalog' })).statusCode).toBe(401);
    for (const type of ['all', 'car', 'motorcycle', 'unknown']) {
      const response = await app.inject({ url: `/admin/api/catalog?vehicle_type=${type}&environment=prod`, headers: { authorization: 'staff' } });
      expect(response.statusCode).toBe(200);
      expect(svc.read).toHaveBeenLastCalledWith(undefined, undefined, type);
    }
    expect((await app.inject({ url: '/admin/api/catalog?vehicle_type=truck', headers: { authorization: 'staff' } })).statusCode).toBe(400);
    await app.inject({ url: '/admin/api/catalog', headers: { authorization: 'staff' } });
    expect(svc.read).toHaveBeenLastCalledWith(undefined, undefined, 'all');
    await app.close();
  });

  it('somente dono classifica e inventaria; omissão não vira moto nem limpa categoria', async () => {
    const app = Fastify(); await registerPainelCatalogo(app);
    const url = '/admin/api/catalog/00000000-0000-4000-8000-000000000001/spec';
    const send = (payload: unknown, role = 'owner') => app.inject({ method: 'POST', url, headers: { authorization: role }, payload });
    expect((await send({ vehicle_type: 'car', reason: 'Conferido' }, 'staff')).statusCode).toBe(403);
    expect((await send({ vehicle_type: 'truck', reason: 'Conferido' })).statusCode).toBe(400);
    svc.edit.mockResolvedValue({ changed: true });
    expect((await send({ vehicle_type: 'car', reason: 'Conferido' })).statusCode).toBe(200);
    expect(svc.edit).toHaveBeenLastCalledWith(expect.objectContaining({ vehicleType: 'car', actorLabel: 'owner:test' }));
    expect((await send({ position: 'rear', reason: 'Conferido' })).statusCode).toBe(200);
    expect(svc.edit).toHaveBeenLastCalledWith(expect.objectContaining({ vehicleType: undefined }));
    svc.edit.mockRejectedValueOnce(new Error('catalog_spec_vehicle_type_conflicts_with_fitments'));
    expect((await send({ vehicle_type: 'car', reason: 'Conferido' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/admin/api/catalog/vehicle-inventory', headers: { authorization: 'staff' } })).statusCode).toBe(403);
    svc.inventory.mockResolvedValue({ rows: [] });
    expect((await app.inject({ url: '/admin/api/catalog/vehicle-inventory', headers: { authorization: 'owner' } })).statusCode).toBe(200);
    await app.close();
  });

  it('aceita carro e condição independentes na criação', async () => {
    const app = Fastify(); await registerPainelCatalogo(app);
    const payload = { measure: '195/65R15', brand: 'Pirelli', tire_condition: 'meia_vida',
      product_code: 'CAR-01', product_name: 'Pneu', creation_mode: 'manual', vehicle_type: 'car' };
    svc.create.mockResolvedValue({ product_id: 'new', vehicle_type: 'car' });
    expect((await app.inject({ method: 'POST', url: '/admin/api/catalog/products', headers: { authorization: 'owner' }, payload })).statusCode).toBe(201);
    expect(svc.create).toHaveBeenLastCalledWith(expect.objectContaining({ tireCondition: 'meia_vida', vehicleType: 'car' }));
    await app.close();
  });
});

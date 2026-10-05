import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ create: vi.fn(), ctx: { environment: 'test', unitId: 'unit-a' } }));
vi.mock('../../../src/parceiro/auth.js', () => ({
  getPartnerContext: () => mocks.ctx,
  requirePartnerAuth: async () => {}, requireScreen: () => async () => {},
}));
vi.mock('../../../src/parceiro/queries.js', () => ({ getPartnerSelfIdentity: async () => ({ display_name: 'Dono' }) }));
vi.mock('../../../src/parceiro/operation-stock-simple.js', () => ({
  createSimpleOperationTire: mocks.create, getSimpleOperationStockPrices: vi.fn(),
  correctSimpleOperationStockBalance: vi.fn(), OperationStockSimpleError: class extends Error {},
}));
import { registerPartnerOperationStockSimpleRoutes } from '../../../src/parceiro/route-operation-stock-simple.js';

describe('cadastro simples pela API', () => {
  it('normaliza os dígitos antes da gravação e mantém a escolha explícita Carro/Moto', async () => {
    const app = Fastify(); registerPartnerOperationStockSimpleRoutes(app);
    try {
      mocks.create.mockReset().mockResolvedValue({ stock_id: 'new-stock' });
      const body = { tire_size: '1956515', vehicle_type: 'car', brand: 'Pirelli',
        tire_condition: 'novo', quantity_on_hand: 3, sale_price: 180 };
      const response = await app.inject({ method: 'POST', url: '/parceiro/loja/api/operacao/estoque/itens', payload: body });
      expect(response.statusCode).toBe(201);
      expect(mocks.create).toHaveBeenCalledWith(mocks.ctx, 'Dono', {
        ...body, tire_size: '195/65-15', tire_width_mm: 195, tire_aspect_ratio: 65, tire_rim_diameter: 15,
      });
      mocks.create.mockClear();
      for (const changes of [{ tire_size: '1956515abc' }, { vehicle_type: 'truck' }, { sale_price: 180.123 }]) {
        const failure = await app.inject({ method: 'POST', url: '/parceiro/loja/api/operacao/estoque/itens', payload: { ...body, ...changes } });
        expect(failure.statusCode).toBe(400);
      }
      expect(mocks.create).not.toHaveBeenCalled();
      const legacy = { ...body, vehicle_type: undefined, tire_size: '90/90-18' };
      expect((await app.inject({ method: 'POST', url: '/parceiro/loja/api/operacao/estoque/itens', payload: legacy })).statusCode).toBe(201);
    } finally { await app.close(); }
  });
});

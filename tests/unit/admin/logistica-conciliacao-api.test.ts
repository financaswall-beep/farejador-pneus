import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
const service = vi.hoisted(() => ({ correct: vi.fn() }));
const config = vi.hoisted(() => ({ FAREJADOR_ENV: 'test', MATRIZ_LOGISTICS: true }));
const access = vi.hoisted(() => ({ owner: true }));
vi.mock('../../../src/admin/painel/queries-logistica-conciliacao.js', () => ({ correctMatrizTripFuelAnnotation: service.correct }));
vi.mock('../../../src/shared/config/env.js', () => ({ env: config }));
vi.mock('../../../src/admin/auth.js', () => ({ getAdminContext: () => ({ authType: 'session', displayName: 'Dono', username: 'wallace' }),
  requireAdminOwner: async (_: any, reply: any) => { if (!access.owner) return reply.code(403).send({ error: 'forbidden' }); } }));
import { registerLogisticsReconciliationRoutes } from '../../../src/admin/painel/route-logistica-conciliacao.js';
const payload = { trip_id: '11111111-1111-4111-8111-111111111111', amount: 0, expected_amount: 22533,
  reason: 'Erro de digitação', idempotency_key: 'logistics-fuel-001' };
describe('API da correção operacional de combustível', () => {
  it('exige proprietário, respeita flag e não aceita ambiente nem autor fornecidos pelo cliente', async () => {
    const app = Fastify(); await registerLogisticsReconciliationRoutes(app);
    const send = (body: object = payload) => app.inject({ method: 'POST', url: '/admin/api/logistica/rotas/corrigir-combustivel', payload: body });
    service.correct.mockClear(); access.owner = false;
    expect((await send()).statusCode).toBe(403); access.owner = true; config.MATRIZ_LOGISTICS = false;
    expect((await send()).statusCode).toBe(404); config.MATRIZ_LOGISTICS = true;
    for (const extra of [{ environment: 'prod' }, { actor_label: 'forged' }, { amount: -1 }, { amount: 1.001 }, { reason: '' }]) {
      expect((await send({ ...payload, ...extra })).statusCode).toBe(400);
    }
    expect(service.correct).not.toHaveBeenCalled();
    service.correct.mockResolvedValue({ trip_id: payload.trip_id, fuel_spent: 0, financial_status: 'reconciled' });
    expect((await send()).statusCode).toBe(200);
    expect(service.correct).toHaveBeenCalledWith({ ...payload, environment: 'test', actor_label: 'Dono (wallace)' });
    service.correct.mockRejectedValue(new Error('trip_fuel_annotation_changed'));
    expect((await send()).statusCode).toBe(409);
    await app.close();
  });
});

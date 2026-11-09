import Fastify from 'fastify';
import { beforeEach, it, expect, vi } from 'vitest';
const m = vi.hoisted(() => ({ owner: true, authenticated: true, ready: vi.fn(), preview: vi.fn(), confirm: vi.fn(), reverse: vi.fn(), history: vi.fn(), products: vi.fn() }));
vi.mock('../../../src/admin/auth.js', () => ({
  requireAdminAuth: async (_: any, reply: any) => { if (!m.authenticated) return reply.code(401).send({ error: 'unauthorized' }); },
  requireAdminOwner: async (_: any, reply: any) => { if (!m.owner) return reply.code(403).send({ error: 'owner_required' }); },
}));
vi.mock('../../../src/admin/painel/route-helpers.js', () => ({ operatorLabel: () => 'owner:session', mapWriteError: () => ({ status: 500, error: 'internal_error' }) }));
vi.mock('../../../src/admin/painel/tire-transfer-read.js', () => ({ tireTransfersReady: m.ready, listTireTransfers: m.history, listTransferProducts: m.products }));
vi.mock('../../../src/persistence/db.js', () => ({ pool: {} }));
vi.mock('../../../src/shared/config/env.js', () => ({ env: { FAREJADOR_ENV: 'test' } }));
vi.mock('../../../src/admin/painel/tire-stock-transfers.js', async original => ({
  ...await original<typeof import('../../../src/admin/painel/tire-stock-transfers.js')>(),
  previewTireTransfer: m.preview, confirmTireTransfer: m.confirm, reverseTireTransfer: m.reverse,
}));
import { registerTireTransferRoutes } from '../../../src/admin/painel/route-tire-transfers.js';
const base = '/admin/api/wholesale/stock-transfers';
const input = { kind: 'loss', lot_id: 'e15ad170-e356-4ce9-8e59-dc192c875b0a', quantity: 1, reason: 'Pneu inutilizável' };
beforeEach(() => { vi.clearAllMocks(); m.owner = true; m.authenticated = true; m.ready.mockResolvedValue(true); });
it('autentica antes da consulta ao banco e exige dono em todas as escritas', async () => {
  const app = Fastify(); await registerTireTransferRoutes(app);
  try {
    m.owner = false; m.authenticated = false;
    for (const url of [base, base + '/preview', base + '/reverse']) expect((await app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(403);
    expect((await app.inject(base)).statusCode).toBe(401);
    expect(m.ready).not.toHaveBeenCalled(); expect(m.confirm).not.toHaveBeenCalled();
  } finally { await app.close(); }
});
it('bloqueia atualização incompleta antes de ler ou modificar as tabelas novas', async () => {
  const app = Fastify(); await registerTireTransferRoutes(app); m.ready.mockResolvedValue(false);
  try {
    for (const url of [base, base + '/preview', base + '/reverse']) expect((await app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(503);
    expect(m.confirm).not.toHaveBeenCalled(); expect(m.preview).not.toHaveBeenCalled(); expect(m.reverse).not.toHaveBeenCalled();
  } finally { await app.close(); }
});
it('exige prévia, rejeita ambiente/custo arbitrário e usa o operador da sessão', async () => {
  const app = Fastify(); await registerTireTransferRoutes(app);
  try {
    expect((await app.inject({ method: 'POST', url: base, payload: { input, idempotency_key: 'operation-key' } })).statusCode).toBe(400);
    const body = { input, fingerprint: 'a'.repeat(64), idempotency_key: 'operation-key' };
    expect((await app.inject({ method: 'POST', url: base, payload: { ...body, environment: 'prod' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: base, payload: { ...body, input: { ...input, cost: 0 } } })).statusCode).toBe(400);
    m.confirm.mockResolvedValueOnce({ id: 'confirmed' });
    expect((await app.inject({ method: 'POST', url: base, payload: body })).statusCode).toBe(201);
    expect(m.confirm).toHaveBeenCalledWith(input, body.fingerprint, body.idempotency_key, 'owner:session');
    m.reverse.mockRejectedValueOnce(Error('transfer_has_later_movements'));
    expect((await app.inject({ method: 'POST', url: base + '/reverse', payload: { id: input.lot_id, reason: 'Conferência de estorno', idempotency_key: 'reverse-key' } })).statusCode).toBe(409);
  } finally { await app.close(); }
});

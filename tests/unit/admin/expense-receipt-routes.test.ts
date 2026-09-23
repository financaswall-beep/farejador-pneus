import Fastify from 'fastify';
import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ ready: vi.fn(), add: vi.fn(), get: vi.fn(), image: vi.fn(), forExpense: vi.fn(), read: vi.fn(), enabled: true, ai: true }));
vi.mock('../../../src/shared/config/env.js', () => ({ env: { get MATRIZ_EXPENSES() { return m.enabled; }, get MATRIZ_RECEIPT_AI() { return m.ai; } } }));
vi.mock('../../../src/admin/painel/expense-receipts.js', () => ({ expenseReceiptsReady: m.ready, addExpenseReceipt: m.add, getExpenseReceipt: m.get, getExpenseReceiptImage: m.image, receiptForExpense: m.forExpense }));
vi.mock('../../../src/admin/painel/expense-receipt-ai.js', () => ({ readExpenseReceipt: m.read }));
vi.mock('../../../src/persistence/db.js', () => ({ pool: {} }));
import { registerExpenseReceiptRoutes } from '../../../src/admin/painel/route-expense-receipts.js';
import { __resetRateLimit } from '../../../src/shared/rate-limit.js';
const id = '00000000-0000-4000-8000-000000000001', base = '/expense';
function appFor(role = 'owner', authenticated = true, finance = true) {
  const app = Fastify();
  const read = [async (_: any, reply: any) => { if (!authenticated) await reply.code(401).send(); else if (!finance) await reply.code(403).send(); }];
  registerExpenseReceiptRoutes(app, { prefix: base, read, write: [...read, async (_: any, reply: any) => { if (role !== 'owner') await reply.code(403).send(); }], actor: () => 'fixture-owner' });
  return app;
}
beforeEach(() => {
  vi.clearAllMocks(); __resetRateLimit(); m.enabled = true; m.ai = true; m.ready.mockResolvedValue(true);
  m.add.mockResolvedValue({ receipt: { id }, duplicate: false }); m.get.mockResolvedValue({ id }); m.read.mockResolvedValue({ id });
  m.image.mockResolvedValue({ bytes: Buffer.from('image'), mime: 'image/jpeg' }); m.forExpense.mockResolvedValue({ id });
});
describe('Rotas de comprovante compartilhadas entre app e web', () => {
  it('valida e reencoda arquivo real; não chama IA ou financeiro durante upload', async () => {
    const app = appFor(); try {
      const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } }).png().toBuffer();
      const r = await app.inject({ method: 'POST', url: base + '/comprovantes', headers: { 'content-type': 'image/png' }, payload: png });
      expect(r.statusCode).toBe(201); expect(r.headers['cache-control']).toBe('no-store');
      const bytes = m.add.mock.calls[0]![0]; expect((await sharp(bytes).metadata()).format).toBe('jpeg');
      expect(m.read).not.toHaveBeenCalled();
      expect((await app.inject({ method: 'POST', url: base + '/comprovantes', headers: { 'content-type': 'image/jpeg' }, payload: Buffer.from('<svg>script</svg>') })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: base + '/comprovantes', headers: { 'content-type': 'image/jpeg' }, payload: Buffer.alloc(8 * 1024 * 1024 + 1) })).statusCode).toBe(413);
    } finally { await app.close(); }
  });
  it.each([['admin', true, true, 403], ['owner', false, true, 401], ['owner', true, false, 403]] as const)('bloqueia escrita: %s, sessão=%s, financeiro=%s', async (role, auth, finance, status) => {
    const app = appFor(role, auth, finance); try {
      expect((await app.inject({ method: 'POST', url: base + '/comprovantes/' + id + '/ler', payload: {} })).statusCode).toBe(status);
      expect((await app.inject(base + '/comprovantes/' + id + '/previa')).statusCode).toBe(status);
      expect(m.read).not.toHaveBeenCalled(); expect(m.image).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('permite ao financeiro ler apenas a imagem já vinculada e nunca usa cache público', async () => {
    const app = appFor('admin'); try {
      const r = await app.inject(base + '/comprovantes/' + id + '/imagem');
      expect(r.statusCode).toBe(200); expect(r.headers['cache-control']).toBe('no-store'); expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(m.image).toHaveBeenCalledWith(id, true);
      expect((await app.inject(base + '/' + id + '/comprovante')).json()).toEqual({ receipt: { id } });
    } finally { await app.close(); }
  });
  it('respeita migrations, flags, ids e limite de requisições', async () => {
    const app = appFor(); try {
      const read = () => app.inject({ method: 'POST', url: base + '/comprovantes/' + id + '/ler', payload: {} });
      m.ready.mockResolvedValue(false); expect((await read()).statusCode).toBe(503);
      m.ready.mockResolvedValue(true); m.ai = false; expect((await read()).statusCode).toBe(409); expect(m.read).not.toHaveBeenCalled();
      m.ai = true; expect((await app.inject(base + '/comprovantes/invalido')).statusCode).toBe(400);
      for (let i = 0; i < 20; i++) await read(); expect((await read()).statusCode).toBe(429);
      m.enabled = false; expect((await app.inject(base + '/' + id + '/comprovante')).statusCode).toBe(404);
    } finally { await app.close(); }
  });
});

import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const { settle } = vi.hoisted(() => ({ settle: vi.fn() }));
vi.mock('../../../src/admin/painel/finance-settlement-service.js', async importOriginal => ({
  ...await importOriginal<object>(), settleFinanceItem: settle,
}));
vi.mock('../../../src/shared/config/env.js', () => ({ env: { FAREJADOR_ENV: 'test' } }));
vi.mock('../../../src/persistence/db.js', () => ({ pool: {} }));
import { registerCaixaFinanceAccountsRoutes } from '../../../src/admin/caixa/route-finance-accounts.js';
const payment = { settlement_mode: 'wholesale_purchase', target_id: 'purchase:1',
  obligation_id: '11111111-1111-4111-8111-111111111111', amount: 80,
  paid_at: '2026-01-01T15:00:00Z', payment_method: 'pix', cash_account: 'Caixa principal', idempotency_key: 'app-account-test-1' };
async function appFor(role = 'owner', authenticated = true, allowed = true) {
  const app = Fastify();
  registerCaixaFinanceAccountsRoutes(app, async () => {}, async (request, reply) => {
    if (!authenticated) { await reply.code(401).send({ error: 'unauthorized' }); return; }
    (request as any).caixa = { panelRole: role, displayName: 'Responsável teste' };
  }, async (_, reply) => { if (!allowed) await reply.code(403).send({ error: 'forbidden' }); });
  return app;
}
describe('baixa de contas do app pelo serviço web', () => {
  beforeEach(() => { settle.mockReset().mockResolvedValue({ transaction_id: 'existing-engine' }); });
  it('repassa exatamente o contrato validado, o ator e a chave de idempotência', async () => {
    const app = await appFor(); const result = await app.inject({ method: 'POST', url: '/api/caixa/financeiro-contas/baixar', payload: payment });
    expect(result.statusCode).toBe(200); expect(settle).toHaveBeenCalledWith(payment, 'Responsável teste'); await app.close();
  });
  it.each([['admin', true, true, 403], ['owner', false, true, 401], ['owner', true, false, 403]] as const)(
    'bloqueia papel=%s sessão=%s acesso=%s antes do serviço', async (role, authenticated, allowed, status) => {
      const app = await appFor(role, authenticated, allowed); const res = await app.inject({ method: 'POST', url: '/api/caixa/financeiro-contas/baixar', payload: payment });
      expect(res.statusCode).toBe(status); expect(settle).not.toHaveBeenCalled(); await app.close();
    });
  it.each([{ amount: 1.005 }, { amount: -1 }, { obligation_id: undefined }, { payment_method: '' },
    { paid_at: '2199-12-31T12:00:00Z' }, { settlement_mode: 'expense', amount: 5 }])('recusa baixa inválida %j', async changes => {
    const app = await appFor(); const res = await app.inject({ method: 'POST', url: '/api/caixa/financeiro-contas/baixar', payload: { ...payment, ...changes } });
    expect(res.statusCode).toBe(400); expect(settle).not.toHaveBeenCalled(); await app.close();
  });
  it('informa conflito se o saldo mudou, sem anunciar pagamento', async () => {
    settle.mockRejectedValue(new Error('settlement_exceeds_balance')); const app = await appFor();
    const res = await app.inject({ method: 'POST', url: '/api/caixa/financeiro-contas/baixar', payload: payment });
    expect(res.statusCode).toBe(409); expect(res.json()).not.toHaveProperty('settled'); await app.close();
  });
});

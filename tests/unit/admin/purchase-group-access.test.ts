import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { requiredMatrixModules } from '../../../src/admin/panel-modules.js';

const context = vi.hoisted(() => ({ role: 'admin', modules: ['compras'] }));
vi.mock('../../../src/admin/auth.js', () => ({
  requireAdminAuth: async function requireAdminAuth() {},
  requireAdminOwner: async function requireAdminOwner() {},
  getAdminContext: () => context,
}));
vi.mock('../../../src/admin/painel/queries-purchase-groups-write.js', () => ({
  createPurchaseGroup: vi.fn(), changePurchaseGroup: vi.fn(), linkPurchaseGroup: vi.fn(),
}));
vi.mock('../../../src/admin/painel/queries-purchase-groups.js', () => ({
  listPurchaseGroups: vi.fn(), eligiblePurchaseGroupExpenses: vi.fn(), purchaseGroupForPurchase: vi.fn(),
  getPurchaseGroup: async () => ({ group: {}, summary: { total: '10.00' },
    purchases: [{ total_amount: '10.00', payment_status: 'paid', paid_at: '2026-01-01', due_date: null,
      payment_method: 'Pix', installments: [{ amount: '10.00' }] }],
    expenses: [{ amount: '2.00', payment_status: 'paid', paid_at: '2026-01-01', due_date: null }],
  }),
}));

describe('Viagem: autorização e valores de pagamento', () => {
  const app = Fastify(); const routes: any[] = [];
  beforeAll(async () => {
    Object.assign(process.env, { NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'test' });
    app.addHook('onRoute', route => { routes.push(route); });
    const { registerPurchaseGroupRoutes } = await import('../../../src/admin/painel/route-purchase-groups.js');
    await registerPurchaseGroupRoutes(app); await app.ready();
  });
  afterAll(() => app.close());
  it('compartilha a etiqueta com Financeiro sem ampliar o acesso às compras de origem', () => {
    expect(requiredMatrixModules('/admin/api/wholesale/purchase-groups')).toEqual(['compras', 'financeiro']);
    expect(requiredMatrixModules('/admin/api/wholesale/purchases/report')).toEqual(['compras']);
    expect(requiredMatrixModules('/admin/api/matriz/despesas')).toEqual(['financeiro']);
  });
  it('preserva custo e esconde pagamentos de quem só tem Compras', async () => {
    context.role = 'admin'; context.modules = ['compras'];
    const result = (await app.inject('/admin/api/wholesale/purchase-groups/11111111-1111-4111-8111-111111111111')).json();
    expect(result.can_view_payments).toBe(false);
    expect(result.purchases[0].total_amount).toBe('10.00');
    for (const field of ['payment_status', 'paid_at', 'due_date', 'payment_method', 'installments']) expect(result.purchases[0]).not.toHaveProperty(field);
    expect(result.expenses[0]).not.toHaveProperty('payment_status');
  });
  it('Financeiro enxerga o pagamento do registro, sem saldo consolidado da viagem', async () => {
    context.modules = ['financeiro'];
    const result = (await app.inject('/admin/api/wholesale/purchase-groups/11111111-1111-4111-8111-111111111111')).json();
    expect(result.can_view_payments).toBe(true);
    expect(result.purchases[0].payment_status).toBe('paid');
    expect(result.summary).not.toHaveProperty('paid');
  });
  it('toda escrita e a busca de despesas candidatas usam o mesmo guarda de dono', async () => {
    const { requireAdminOwner } = await import('../../../src/admin/auth.js');
    const writes = routes.filter(r => r.method === 'POST');
    expect(writes).toHaveLength(3);
    expect(writes.every(r => r.preHandler === requireAdminOwner)).toBe(true);
    expect(routes.find(r => r.url.endsWith('/eligible-expenses')).preHandler).toBe(requireAdminOwner);
  });
});

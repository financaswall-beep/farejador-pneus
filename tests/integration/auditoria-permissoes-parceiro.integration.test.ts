// AUDITORIA 02/10/2026 - F2.3 balconista cancela venda paga (API real).
// Mover para tests/integration/ JUNTO com o conserto do item (ver docs/PLANO_CORRECOES_AUDITORIA_2026-10-02.md).
// rotas e autenticacao reais (token real, pool restrito com RLS).
import { createHash, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPartnerFixture, type PartnerFixture } from './helpers/partner-fixtures.js';
import { buildRestrictedConnectionString, startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('auditoria: permissoes do parceiro pela API', () => {
  let db: IntegrationDb;
  let app: FastifyInstance;
  let a: PartnerFixture;
  let b: PartnerFixture;
  let employeeToken: string;
  let partner: typeof import('../../src/parceiro/queries.js');

  beforeAll(async () => {
    Object.assign(process.env, { NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'emergency-token' });
    db = await startPostgres();
    process.env.DATABASE_URL = db.connectionString;
    process.env.PARTNER_DATABASE_URL = buildRestrictedConnectionString(db.connectionString);
    vi.resetModules();
    a = await createPartnerFixture(db.pool, { slugSuffix: 'loja-a', initialStockQty: 10 });
    b = await createPartnerFixture(db.pool, { slugSuffix: 'loja-b', initialStockQty: 10 });
    employeeToken = `token-func-${randomUUID()}`;
    const emp = (await db.pool.query(`INSERT INTO network.partner_access_tokens
        (environment,partner_unit_id,token_hash,label,created_by,role)
      VALUES ('test',$1,$2,'balconista','fixture','funcionario') RETURNING id`,
      [a.partnerUnitId, createHash('sha256').update(employeeToken, 'utf8').digest('hex')])).rows[0].id;
    // Balconista: SO a tela de Retiradas (sem Vendas, sem Financeiro).
    await db.pool.query(`INSERT INTO network.partner_token_permissions
        (token_id,environment,partner_unit_id,allow_vendas,allow_estoque,allow_pedidos,allow_clientes,
         allow_entregas,allow_retiradas,allow_batepapo,allow_resumo,allow_financeiro)
      VALUES ($1,'test',$2,false,false,false,false,false,true,false,false,false)`, [emp, a.partnerUnitId]);
    partner = await import('../../src/parceiro/queries.js');
    const { registerParceiroRoute } = await import('../../src/parceiro/route.js');
    app = Fastify();
    await registerParceiroRoute(app);
    await app.ready();
  }, 240_000);
  afterAll(async () => {
    if (app) await app.close();
    const { partnerPool } = await import('../../src/parceiro/db.js');
    await partnerPool.end().catch(() => undefined);
    if (db) await stopPostgres(db);
  });

  const call = (method: 'GET' | 'POST' | 'DELETE', slug: string, path: string, token: string, payload?: object) =>
    app.inject({ method, url: `/parceiro/${slug}/api${path}`, headers: { 'x-partner-token': token }, payload });

  async function counterSale(fx: PartnerFixture, key = randomUUID()) {
    return partner.registerPartnerSale(fx.ctx, {
      customer_name: 'Cliente balcao', customer_phone: null,
      items: [{ partner_stock_id: fx.stockId, quantity: 1, unit_price: 150 }],
      payment_method: 'Pix', payment_status: 'received', fulfillment_mode: 'pickup',
      delivery_address: null, source_tag: 'porta', idempotency_key: key,
    } as never, db.pool);
  }

  it('dono da loja A nao alcanca a loja B; token de A nao abre B', async () => {
    const saleB = await counterSale(b);
    const r1 = await call('DELETE', a.slug, `/vendas/${saleB.order_id}`, a.tokenPlain, { reason: 'ataque cruzado' });
    const r2 = await call('POST', a.slug, `/entregas/${saleB.order_id}`, a.tokenPlain, { delivery_status: 'delivered', payment_method: 'pix' });
    const r3 = await call('GET', b.slug, '/vendas', a.tokenPlain);
    const still = (await db.pool.query(`SELECT status FROM commerce.partner_orders WHERE id=$1`, [saleB.order_id])).rows[0].status;
    console.log('CRUZADO A->B:', JSON.stringify({ cancelar: r1.statusCode, entregar: r2.statusCode, token_A_no_slug_B: r3.statusCode, pedido_B: still }));
    expect.soft([r1.statusCode, r2.statusCode]).toEqual([404, 404]);
    expect.soft(r3.statusCode).toBe(401);
    expect.soft(still).not.toBe('cancelled');
  });

  it('balconista so com Retiradas: o que a API deixa fazer', async () => {
    const sale = await counterSale(a);
    const vendas = await call('DELETE', a.slug, `/vendas/${sale.order_id}`, employeeToken, { reason: 'teste' });
    const caixa = await call('GET', a.slug, '/fluxo-caixa', employeeToken);
    const viaRetiradas = await call('DELETE', a.slug, `/retiradas/${sale.order_id}`, employeeToken, { reason: 'cancelei pela tela de retiradas' });
    const order = (await db.pool.query(`SELECT status,fulfillment_mode,payment_method FROM commerce.partner_orders WHERE id=$1`, [sale.order_id])).rows[0];
    const stock = (await db.pool.query(`SELECT quantity_on_hand FROM commerce.partner_stock_levels WHERE id=$1`, [a.stockId])).rows[0].quantity_on_hand;
    const audit = (await db.pool.query(`SELECT event_type,actor_label FROM audit.events WHERE entity_id=$1 ORDER BY created_at`, [sale.order_id])).rows;
    console.log('BALCONISTA:', JSON.stringify({ cancelar_via_vendas: vendas.statusCode, ver_caixa: caixa.statusCode,
      cancelar_venda_paga_via_retiradas: viaRetiradas.statusCode, pedido: order, estoque_loja: stock, auditoria: audit }));
    expect.soft(vendas.statusCode).toBe(403);
    expect.soft(caixa.statusCode).toBe(403);
    // Uma venda de balcao ja paga nao e "retirada pendente": a tela de Retiradas nao deveria cancela-la.
    expect.soft(viaRetiradas.statusCode).not.toBe(200);
    expect(order.status).not.toBe('cancelled');
  });

  it('recuperação por chave não vaza venda de outra loja ou de outro operador', async () => {
    const key = randomUUID();
    const sale = await counterSale(a, key);
    const path = '/vendas/por-chave/' + key;
    const own = await call('GET', a.slug, path, a.tokenPlain);
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({found:true,order_id:sale.order_id});
    expect((await call('GET', b.slug, path, b.tokenPlain)).json()).toEqual({found:false});
    expect((await call('GET', a.slug, path, employeeToken)).statusCode).toBe(403);
    await db.pool.query(`UPDATE commerce.partner_orders SET operator_token_id=NULL WHERE id=$1`, [sale.order_id]);
    expect((await call('GET', a.slug, path, a.tokenPlain)).json()).toEqual({found:false});
  });
});

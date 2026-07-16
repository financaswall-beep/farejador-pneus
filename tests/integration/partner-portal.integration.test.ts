/**
 * Testes mínimos do Portal Parceiro — etapa 3 do plano de correção da auditoria
 * de 2026-05-21.
 *
 * Cobertura:
 *   1. Venda baixa estoque (decremento atômico)
 *   2. Estoque insuficiente retorna erro controlado (BUG #2 da 0042)
 *   3. Cancelamento restaura estoque
 *   4. Token revogado retorna 401
 *   5. Isolamento entre parceiros (3 sub-casos):
 *      5a. Token A lista vendas → não aparece venda da unidade B
 *      5b. Token A tenta cancelar pedido da unidade B → não-cancelled
 *      5c. Token A tenta vender usando partner_stock_id da unidade B → erro
 *
 * Cada teste usa fixtures isoladas (slug UUID-based) — não há cleanup entre
 * testes, mas como o banco é efêmero (testcontainers), tudo morre no afterAll.
 *
 * Não toca em bot/atendente/planner/organizadora.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres';
import { createPartnerFixture, getStockQty } from './helpers/partner-fixtures';

let db: IntegrationDb;

beforeAll(async () => {
  db = await startPostgres();
  // Env vars necessárias antes de qualquer dynamic import de módulos do app
  process.env.DATABASE_URL = db.connectionString;
  process.env.FAREJADOR_ENV = 'test';
  process.env.NODE_ENV = 'test';
  process.env.CHATWOOT_HMAC_SECRET = 'test-secret-not-used-here';
  process.env.ADMIN_AUTH_TOKEN = 'admin-not-used-here-1234567890';
}, 180_000);

afterAll(async () => {
  if (db) await stopPostgres(db);
});

// --------------------------------------------------------------
// Helper: import dinâmico das queries, garantindo que env já está setado
// --------------------------------------------------------------
async function importQueries() {
  return import('../../src/parceiro/queries.js');
}

async function importAuth() {
  return import('../../src/parceiro/auth.js');
}

// Helper: factory de reply mock no estilo do tests/unit/admin/auth.test.ts
interface MockReply {
  statusCode: number;
  payload: unknown;
  status: (code: number) => MockReply;
  send: (payload: unknown) => MockReply;
}
function createMockReply(): MockReply {
  const reply: MockReply = {
    statusCode: 200,
    payload: undefined,
    status(code) { this.statusCode = code; return this; },
    send(payload) { this.payload = payload; return this; },
  };
  return reply;
}

// --------------------------------------------------------------
// 1. Venda baixa estoque
// --------------------------------------------------------------
describe('Portal Parceiro — venda baixa estoque', () => {
  it('decrementa quantity_on_hand atomicamente ao registrar venda', async () => {
    const q = await importQueries();
    const f = await createPartnerFixture(db.pool, { initialStockQty: 10 });

    const result = await q.registerPartnerSale(f.ctx, {
      customer_name: 'Cliente Teste',
      customer_phone: null,
      items: [{
        partner_stock_id: f.stockId,
        quantity: 3,
        unit_price: 150,
      }],
      payment_method: 'pix',
      fulfillment_mode: 'pickup',
      source_tag: 'porta',
      idempotency_key: `test-${randomUUID()}`,
    }, db.pool);

    expect(result.order_id).toBeTruthy();
    expect(await getStockQty(db.pool, f.stockId)).toBe(7);
  });

  it('emite 2 eventos audit: partner_order_created + stock_decrement_sale (BUG #5 da 0042)', async () => {
    const q = await importQueries();
    const f = await createPartnerFixture(db.pool, { initialStockQty: 5 });

    const result = await q.registerPartnerSale(f.ctx, {
      customer_name: 'Audit',
      customer_phone: null,
      items: [{ partner_stock_id: f.stockId, quantity: 1, unit_price: 100 }],
      payment_method: 'pix',
      fulfillment_mode: 'pickup',
      source_tag: 'porta',
      idempotency_key: `audit-${randomUUID()}`,
    }, db.pool);

    const audits = await db.pool.query<{ event_type: string }>(
      `SELECT event_type FROM audit.events WHERE entity_id = $1 ORDER BY event_type`,
      [result.order_id],
    );
    const types = audits.rows.map((r) => r.event_type);
    expect(types).toContain('partner_order_created');
    expect(types).toContain('stock_decrement_sale');
  });
});

// --------------------------------------------------------------
// 2. Estoque insuficiente → erro controlado (BUG #2 da 0042)
// --------------------------------------------------------------
describe('Portal Parceiro — estoque insuficiente', () => {
  it('levanta erro "Estoque insuficiente" quando quantity > saldo', async () => {
    const q = await importQueries();
    const f = await createPartnerFixture(db.pool, { initialStockQty: 2 });

    await expect(
      q.registerPartnerSale(f.ctx, {
        customer_name: 'Sem Saldo',
        customer_phone: null,
        items: [{ partner_stock_id: f.stockId, quantity: 999, unit_price: 100 }],
        payment_method: 'pix',
        fulfillment_mode: 'pickup',
        source_tag: 'porta',
        idempotency_key: `insuf-${randomUUID()}`,
      }, db.pool),
    ).rejects.toThrow(/Estoque insuficiente/);

    // Estoque NÃO mudou
    expect(await getStockQty(db.pool, f.stockId)).toBe(2);
  });
});

// --------------------------------------------------------------
// 3. Cancelamento restaura estoque
// --------------------------------------------------------------
describe('Portal Parceiro — cancelamento restaura estoque', () => {
  it('restaura quantity_on_hand ao cancelar venda', async () => {
    const q = await importQueries();
    const f = await createPartnerFixture(db.pool, { initialStockQty: 8 });

    const sale = await q.registerPartnerSale(f.ctx, {
      customer_name: 'Pre Cancel',
      customer_phone: null,
      items: [{ partner_stock_id: f.stockId, quantity: 3, unit_price: 100 }],
      payment_method: 'pix',
      fulfillment_mode: 'pickup',
      source_tag: 'porta',
      idempotency_key: `cancel-${randomUUID()}`,
    }, db.pool);

    expect(await getStockQty(db.pool, f.stockId)).toBe(5);

    const cancel = await q.cancelPartnerSale(f.ctx, sale.order_id);
    expect(cancel.cancelled).toBe(true);
    expect(await getStockQty(db.pool, f.stockId)).toBe(8);
  });
});

// --------------------------------------------------------------
// 4. Token revogado → 401
// --------------------------------------------------------------
describe('Portal Parceiro — autenticação', () => {
  it('retorna 401 quando token foi revogado', async () => {
    const { requirePartnerAuth } = await importAuth();
    const f = await createPartnerFixture(db.pool, { revokeToken: true });

    const request = {
      headers: { authorization: `Bearer ${f.tokenPlain}` },
      params: { slug: f.slug },
    } as unknown as Parameters<typeof requirePartnerAuth>[0];

    const reply = createMockReply();
    await requirePartnerAuth(request, reply as unknown as FastifyReply);

    expect(reply.statusCode).toBe(401);
    expect(reply.payload).toEqual({ error: 'partner_unauthorized' });
  });

  it('retorna 401 quando token está errado', async () => {
    const { requirePartnerAuth } = await importAuth();
    const f = await createPartnerFixture(db.pool);

    const request = {
      headers: { authorization: 'Bearer token-errado-1234567890abcdef' },
      params: { slug: f.slug },
    } as unknown as Parameters<typeof requirePartnerAuth>[0];

    const reply = createMockReply();
    await requirePartnerAuth(request, reply as unknown as FastifyReply);

    expect(reply.statusCode).toBe(401);
  });

  it('aceita token válido e popula partnerContext', async () => {
    const { requirePartnerAuth } = await importAuth();
    const f = await createPartnerFixture(db.pool);

    const request = {
      headers: { authorization: `Bearer ${f.tokenPlain}` },
      params: { slug: f.slug },
      partnerContext: undefined,
    } as unknown as Parameters<typeof requirePartnerAuth>[0];

    const reply = createMockReply();
    await requirePartnerAuth(request, reply as unknown as FastifyReply);

    // Não chamou reply.status → request prosseguiu
    expect(reply.statusCode).toBe(200);
    // E o contexto foi populado com a unidade certa
    expect((request as any).partnerContext?.unitId).toBe(f.unitId);
    expect((request as any).partnerContext?.slug).toBe(f.slug);
  });
});

// --------------------------------------------------------------
// Etapa 4 — níveis dono/funcionário (requireOwner)
// --------------------------------------------------------------
describe('Portal Parceiro — autorização por papel (Etapa 4)', () => {
  it('token de dono traz role=owner e passa no requireOwner', async () => {
    const { requirePartnerAuth, requireOwner } = await importAuth();
    const f = await createPartnerFixture(db.pool, { role: 'owner' });

    const request = {
      headers: { authorization: `Bearer ${f.tokenPlain}` },
      params: { slug: f.slug },
      partnerContext: undefined,
    } as unknown as Parameters<typeof requirePartnerAuth>[0];

    const authReply = createMockReply();
    await requirePartnerAuth(request, authReply as unknown as FastifyReply);
    expect((request as any).partnerContext?.role).toBe('owner');

    // requireOwner não deve barrar o dono
    const ownerReply = createMockReply();
    await requireOwner(request, ownerReply as unknown as FastifyReply);
    expect(ownerReply.statusCode).toBe(200);
  });

  it('token de funcionário traz role=funcionario e leva 403 no requireOwner', async () => {
    const { requirePartnerAuth, requireOwner } = await importAuth();
    const f = await createPartnerFixture(db.pool, { role: 'funcionario' });

    const request = {
      headers: { authorization: `Bearer ${f.tokenPlain}` },
      params: { slug: f.slug },
      partnerContext: undefined,
    } as unknown as Parameters<typeof requirePartnerAuth>[0];

    // 1. autentica OK (funcionário é login válido)
    const authReply = createMockReply();
    await requirePartnerAuth(request, authReply as unknown as FastifyReply);
    expect(authReply.statusCode).toBe(200);
    expect((request as any).partnerContext?.role).toBe('funcionario');

    // 2. mas requireOwner barra com 403 (financeiro/config é só do dono)
    const ownerReply = createMockReply();
    await requireOwner(request, ownerReply as unknown as FastifyReply);
    expect(ownerReply.statusCode).toBe(403);
    expect(ownerReply.payload).toEqual({ error: 'partner_forbidden_owner_only' });
  });

  it('requireOwner sem contexto (não autenticado) retorna 401', async () => {
    const { requireOwner } = await importAuth();

    const request = { partnerContext: undefined } as unknown as Parameters<typeof requireOwner>[0];
    const reply = createMockReply();
    await requireOwner(request, reply as unknown as FastifyReply);

    expect(reply.statusCode).toBe(401);
  });
});

// --------------------------------------------------------------
// 6. S4 — normalizacao E.164 do telefone (auditoria 2026-05-21)
// --------------------------------------------------------------
describe('Portal Parceiro — normalizacao de telefone E.164 (S4)', () => {
  it('grava customer_phone em E.164 quando input vem com mascara', async () => {
    const q = await importQueries();
    const f = await createPartnerFixture(db.pool, { initialStockQty: 5 });

    const sale = await q.registerPartnerSale(f.ctx, {
      customer_name: 'Cliente',
      customer_phone: '(21) 99999-9999',
      items: [{ partner_stock_id: f.stockId, quantity: 1, unit_price: 100 }],
      payment_method: 'pix',
      fulfillment_mode: 'pickup',
      source_tag: 'porta',
      idempotency_key: `phone-mask-${randomUUID()}`,
    }, db.pool);

    const order = await db.pool.query<{ customer_phone: string }>(
      `SELECT customer_phone FROM commerce.partner_orders WHERE id = $1`,
      [sale.order_id],
    );
    expect(order.rows[0]?.customer_phone).toBe('+5521999999999');
  });

  it('aceita formato ja-em-E.164 sem dupla normalizacao', async () => {
    const q = await importQueries();
    const f = await createPartnerFixture(db.pool, { initialStockQty: 5 });

    const sale = await q.registerPartnerSale(f.ctx, {
      customer_name: 'Cliente',
      customer_phone: '+5521988887777',
      items: [{ partner_stock_id: f.stockId, quantity: 1, unit_price: 100 }],
      payment_method: 'pix',
      fulfillment_mode: 'pickup',
      source_tag: 'porta',
      idempotency_key: `phone-e164-${randomUUID()}`,
    }, db.pool);

    const order = await db.pool.query<{ customer_phone: string }>(
      `SELECT customer_phone FROM commerce.partner_orders WHERE id = $1`,
      [sale.order_id],
    );
    expect(order.rows[0]?.customer_phone).toBe('+5521988887777');
  });

  it('grava null quando phone e invalido (nao trava venda)', async () => {
    const q = await importQueries();
    const f = await createPartnerFixture(db.pool, { initialStockQty: 5 });

    const sale = await q.registerPartnerSale(f.ctx, {
      customer_name: 'Cliente',
      customer_phone: 'xyz',
      items: [{ partner_stock_id: f.stockId, quantity: 1, unit_price: 100 }],
      payment_method: 'pix',
      fulfillment_mode: 'pickup',
      source_tag: 'porta',
      idempotency_key: `phone-bad-${randomUUID()}`,
    }, db.pool);

    const order = await db.pool.query<{ customer_phone: string | null }>(
      `SELECT customer_phone FROM commerce.partner_orders WHERE id = $1`,
      [sale.order_id],
    );
    expect(order.rows[0]?.customer_phone).toBeNull();
  });
});

// --------------------------------------------------------------
// 7. S1 — timezone-aware da Rede da matriz (auditoria 2026-05-21)
// --------------------------------------------------------------
describe('Painel Admin Rede — timezone-aware (S1)', () => {
  it('getPainelRede com period=month nao quebra e retorna estrutura esperada', async () => {
    // O fix da S1 trocou JS Date local-time por SQL `now() AT TIME ZONE 'America/Sao_Paulo'`.
    // Esse teste so confirma que o SQL nao quebra e retorna o shape esperado.
    // Validacao do TZ propriamente dito exige mock de relogio — fora do escopo desta etapa.
    const f = await createPartnerFixture(db.pool, { initialStockQty: 5 });
    // Cria uma venda pra ter dado real no Resumo Rede
    const q = await importQueries();
    await q.registerPartnerSale(f.ctx, {
      customer_name: 'Cliente TZ',
      customer_phone: null,
      items: [{ partner_stock_id: f.stockId, quantity: 1, unit_price: 100 }],
      payment_method: 'pix',
      fulfillment_mode: 'pickup',
      source_tag: 'porta',
      idempotency_key: `tz-test-${randomUUID()}`,
    }, db.pool);

    // Forca env pro test, dynamic import do admin queries
    process.env.FAREJADOR_ENV = 'test';
    const { getPainelRede } = await import('../../src/admin/painel/queries.js');
    const rows = await getPainelRede('month', db.pool) as Array<Record<string, unknown>>;
    const ours = rows.find((r) => r.unit_id === f.unitId);
    expect(ours).toBeTruthy();
    expect(ours).toHaveProperty('sales_month');
    expect(ours).toHaveProperty('sales_series');
    expect(ours).toHaveProperty('order_series');
  });

  it('todos os periodos (today/7d/30d/month) executam sem erro de SQL', async () => {
    process.env.FAREJADOR_ENV = 'test';
    const { getPainelRede } = await import('../../src/admin/painel/queries.js');
    for (const period of ['today', '7d', '30d', 'month'] as const) {
      await expect(getPainelRede(period, db.pool)).resolves.toBeTruthy();
    }
  });
});

// --------------------------------------------------------------
// 5. Isolamento entre parceiros (3 sub-casos)
// --------------------------------------------------------------
describe('Portal Parceiro — isolamento entre parceiros', () => {
  it('5a: getPartnerVendas com ctx A não retorna venda da unidade B', async () => {
    const q = await importQueries();
    const a = await createPartnerFixture(db.pool, { slugSuffix: 'aa' + randomUUID().slice(0, 6) });
    const b = await createPartnerFixture(db.pool, { slugSuffix: 'bb' + randomUUID().slice(0, 6) });

    // B faz 1 venda
    const saleB = await q.registerPartnerSale(b.ctx, {
      customer_name: 'Cliente B',
      customer_phone: null,
      items: [{ partner_stock_id: b.stockId, quantity: 1, unit_price: 200 }],
      payment_method: 'pix',
      fulfillment_mode: 'pickup',
      source_tag: 'porta',
      idempotency_key: `iso-b-${randomUUID()}`,
    }, db.pool);

    // A lista suas vendas — não pode ver a venda de B
    const vendasA = await q.getPartnerVendas(a.ctx, db.pool) as Array<{ order_id: string }>;
    const idsA = vendasA.map((v) => v.order_id);
    expect(idsA).not.toContain(saleB.order_id);
    expect(vendasA).toHaveLength(0);
  });

  it('5b: cancelPartnerSale com ctx A em orderId de B retorna cancelled=false', async () => {
    const q = await importQueries();
    const a = await createPartnerFixture(db.pool, { slugSuffix: 'aa' + randomUUID().slice(0, 6) });
    const b = await createPartnerFixture(db.pool, { slugSuffix: 'bb' + randomUUID().slice(0, 6) });

    const saleB = await q.registerPartnerSale(b.ctx, {
      customer_name: 'Cliente B',
      customer_phone: null,
      items: [{ partner_stock_id: b.stockId, quantity: 1, unit_price: 200 }],
      payment_method: 'pix',
      fulfillment_mode: 'pickup',
      source_tag: 'porta',
      idempotency_key: `iso-b-cancel-${randomUUID()}`,
    }, db.pool);

    const qtyBBefore = await getStockQty(db.pool, b.stockId);

    const result = await q.cancelPartnerSale(a.ctx, saleB.order_id, db.pool);
    expect(result.cancelled).toBe(false);

    // Estoque de B não foi tocado (cancelamento não aconteceu)
    expect(await getStockQty(db.pool, b.stockId)).toBe(qtyBBefore);

    // Pedido de B continua confirmed (não cancelled)
    const order = await db.pool.query<{ status: string }>(
      `SELECT status FROM commerce.partner_orders WHERE id = $1`,
      [saleB.order_id],
    );
    expect(order.rows[0]?.status).toBe('confirmed');
  });

  it('5c: registerPartnerSale com ctx A usando partner_stock_id de B é bloqueado', async () => {
    const q = await importQueries();
    const a = await createPartnerFixture(db.pool, { slugSuffix: 'aa' + randomUUID().slice(0, 6) });
    const b = await createPartnerFixture(db.pool, { slugSuffix: 'bb' + randomUUID().slice(0, 6) });

    // A tenta vender item de B usando seu próprio ctx (unit_id = a.unitId)
    await expect(
      q.registerPartnerSale(a.ctx, {
        customer_name: 'Atacante',
        customer_phone: null,
        items: [{ partner_stock_id: b.stockId, quantity: 1, unit_price: 100 }],
        payment_method: 'pix',
        fulfillment_mode: 'pickup',
        source_tag: 'porta',
        idempotency_key: `iso-c-${randomUUID()}`,
      }, db.pool),
    ).rejects.toThrow(/Item de estoque nao pertence a esta unidade/);

    // Estoque de B intacto
    expect(await getStockQty(db.pool, b.stockId)).toBe(10);

    // A não criou nenhum pedido
    const ordersA = await db.pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM commerce.partner_orders WHERE unit_id = $1`,
      [a.unitId],
    );
    expect(ordersA.rows[0]?.c).toBe('0');
  });
});

// --------------------------------------------------------------
// 6. Raio de entrega (proximidade-primeiro, Fase 2) — round-trip
// --------------------------------------------------------------
describe('Portal Parceiro — raio de entrega (Fase 2)', () => {
  it('grava e relê delivery_radius_km; pickup zera o raio (NULL)', async () => {
    const q = await importQueries();
    const fx = await createPartnerFixture(db.pool, { slugSuffix: 'raio' + randomUUID().slice(0, 6) });

    // Faz entrega com raio → persiste o número.
    await q.updatePartnerAtendimento(fx.ctx, 'delivery', 8.5);
    let cfg = await q.getPartnerConfiguracoes(fx.ctx);
    expect(cfg.loja?.delivery_radius_km).toBe(8.5);
    expect(cfg.loja?.faz_entrega).toBe(true);

    // Both com outro raio → sobrescreve.
    await q.updatePartnerAtendimento(fx.ctx, 'both', 12);
    cfg = await q.getPartnerConfiguracoes(fx.ctx);
    expect(cfg.loja?.delivery_radius_km).toBe(12);

    // Não faz entrega (pickup) → raio NULL (não há o que limitar).
    await q.updatePartnerAtendimento(fx.ctx, 'pickup', null);
    cfg = await q.getPartnerConfiguracoes(fx.ctx);
    expect(cfg.loja?.delivery_radius_km).toBeNull();
    expect(cfg.loja?.faz_entrega).toBe(false);
  });
});

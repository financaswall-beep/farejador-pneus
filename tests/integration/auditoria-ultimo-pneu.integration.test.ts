// AUDITORIA 02/10/2026 - REGRESSAO (ja passa): ultimo pneu disputado.
// Mover para tests/integration/ JUNTO com o conserto do item (ver docs/PLANO_CORRECOES_AUDITORIA_2026-10-02.md).
// balcao x balcao, reserva do bot x balcao, reserva x reserva — tudo ao mesmo tempo.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

let db: IntegrationDb;
let tools: typeof import('../../src/atendente-v2/tools.js');
let walkin: typeof import('../../src/admin/painel/queries-pedidos-acoes.js');
let serial = 881000;

beforeAll(async () => {
  db = await startPostgres();
  Object.assign(process.env, {
    NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: db.connectionString,
    CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'test-admin-token',
    WHOLESALE_UNIFIED_STOCK: 'true', WHOLESALE_MATRIZ_DECREMENT: 'true',
    WHOLESALE_MATRIZ_OVERSELL_GUARD: 'true', WHOLESALE_MATRIZ_RETAIL_COST: 'true',
    MATRIZ_CENTRAL_LEDGER: 'true', PHOTO_REQUESTS: 'false', GOOGLE_MAPS_API_KEY: 'fixture-no-network',
  });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Rede externa proibida neste teste'); }));
  tools = await import('../../src/atendente-v2/tools.js');
  walkin = await import('../../src/admin/painel/queries-pedidos-acoes.js');
  await db.pool.query(`INSERT INTO core.units(environment,slug,name) VALUES ('test','main','Matriz') ON CONFLICT DO NOTHING`);
}, 240_000);
afterAll(async () => { vi.unstubAllGlobals(); if (db) await stopPostgres(db); });

async function lastTire(measure: string) {
  const id = (await db.pool.query(`INSERT INTO commerce.products(environment,product_code,product_name,product_type,brand,tire_condition)
    VALUES ('test',$1,$2,'tire','Pirelli','meia_vida') RETURNING id`, [`AUD-ULT-${++serial}`, `Pneu ${measure}`])).rows[0].id;
  await db.pool.query(`INSERT INTO commerce.tire_specs(environment,product_id,tire_size) VALUES ('test',$1,$2)`, [id, measure]);
  await db.pool.query(`INSERT INTO commerce.matriz_product_prices(environment,product_id,price_amount) VALUES ('test',$1,99)`, [id]);
  await db.pool.query(`INSERT INTO commerce.wholesale_stock(environment,measure,brand,tire_condition,quantity_on_hand,unit_cost)
    VALUES ('test',$1,'Pirelli','meia_vida',1,40)`, [measure]);
  return id as string;
}
const balcao = (p: string) => walkin.registerWalkinOrder({ environment: 'test', customer_name: 'Balcao', customer_phone: null,
  unit_id: null, items: [{ product_id: p, quantity: 1, unit_price: 99 }], payment_method: 'pix', fulfillment_mode: 'pickup',
  delivery_address: null, actor_label: 'auditoria', idempotency_key: randomUUID(), source_tag: 'walkin_balcao' } as never, db.pool)
  .then(() => 'vendeu', (e: Error) => `recusou: ${e.message}`);
async function bot(p: string) {
  const cw = ++serial;
  const contact = (await db.pool.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name,phone_e164)
    VALUES ('test',$1,'Cliente bot','+5521999990000') RETURNING id`, [cw])).rows[0].id;
  const conv = (await db.pool.query(`INSERT INTO core.conversations(environment,chatwoot_conversation_id,chatwoot_account_id,
    contact_id,current_status,started_at,last_activity_at) VALUES ('test',$1,9818,$2,'open',now(),now()) RETURNING id`, [cw, contact])).rows[0].id;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const r = JSON.parse(await tools.executeTool(client, 'test', conv, 'criar_pedido', { nome_cliente: 'Joao Cliente',
      modalidade: 'pickup', forma_pagamento: 'pix', itens: [{ product_id: p, quantidade: 1, preco_unitario: 99 }] }));
    await client.query('COMMIT');
    return r.ok ? 'reservou' : `recusou: ${r.erro}`;
  } catch (e) { await client.query('ROLLBACK').catch(() => undefined); return `recusou: ${(e as Error).message}`; }
  finally { client.release(); }
}
const state = async (m: string) => (await db.pool.query(`SELECT quantity_on_hand,quantity_reserved FROM commerce.wholesale_stock WHERE environment='test' AND measure=$1`, [m])).rows[0];

describe('auditoria: ultimo pneu disputado', () => {
  it('balcao x balcao, bot x balcao, bot x bot', async () => {
    const r: Record<string, unknown> = {};
    const p1 = await lastTire('120/70-17');
    r.balcao_x_balcao = { resultado: await Promise.all([balcao(p1), balcao(p1)]), estoque: await state('120/70-17') };
    const p2 = await lastTire('130/70-17');
    r.bot_x_balcao = { resultado: await Promise.all([bot(p2), balcao(p2)]), estoque: await state('130/70-17') };
    const p3 = await lastTire('140/70-17');
    r.bot_x_bot = { resultado: await Promise.all([bot(p3), bot(p3)]), estoque: await state('140/70-17') };
    console.log('ULTIMO PNEU:', JSON.stringify(r));
    for (const key of ['balcao_x_balcao', 'bot_x_balcao', 'bot_x_bot']) {
      const v = r[key] as { resultado: string[]; estoque: { quantity_on_hand: number; quantity_reserved: number } };
      expect.soft(v.resultado.filter((x) => !x.startsWith('recusou')).length, key).toBe(1);
      expect.soft(v.estoque.quantity_on_hand - v.estoque.quantity_reserved, key).toBeGreaterThanOrEqual(0);
    }
  });
});

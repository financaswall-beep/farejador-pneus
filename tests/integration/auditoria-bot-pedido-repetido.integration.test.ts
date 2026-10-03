// AUDITORIA 02/10/2026 - F1.2 bot devolve pedido antigo + F3.1 bot cancela na hora da retirada.
// Mover para tests/integration/ JUNTO com o conserto do item (ver docs/PLANO_CORRECOES_AUDITORIA_2026-10-02.md).
// Cenarios: pedir de novo apos cancelar; pedir de novo apos retirar; bot cancela no instante da retirada.
import { randomUUID } from 'node:crypto';
import { waitForDatabaseBlock } from './helpers/database-barrier.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

let db: IntegrationDb;
let tools: typeof import('../../src/atendente-v2/tools.js');
let serial = 771000;

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
  await db.pool.query(`INSERT INTO core.units(environment,slug,name) VALUES ('test','main','Matriz') ON CONFLICT DO NOTHING`);
}, 240_000);
afterAll(async () => { vi.unstubAllGlobals(); if (db) await stopPostgres(db); });

async function conversation() {
  const cw = ++serial;
  const contact = (await db.pool.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name,phone_e164)
    VALUES ('test',$1,'Cliente bot','+5521999990000') RETURNING id`, [cw])).rows[0].id;
  return (await db.pool.query(`INSERT INTO core.conversations(environment,chatwoot_conversation_id,chatwoot_account_id,
    contact_id,current_status,started_at,last_activity_at) VALUES ('test',$1,9818,$2,'open',now(),now()) RETURNING id`,
  [cw, contact])).rows[0].id as string;
}
async function product(measure: string) {
  const id = (await db.pool.query(`INSERT INTO commerce.products(environment,product_code,product_name,product_type,brand,tire_condition)
    VALUES ('test',$1,$2,'tire','Pirelli','meia_vida') RETURNING id`, [`AUD-BOT-${++serial}`, `Pneu ${measure}`])).rows[0].id;
  await db.pool.query(`INSERT INTO commerce.tire_specs(environment,product_id,tire_size) VALUES ('test',$1,$2)`, [id, measure]);
  await db.pool.query(`INSERT INTO commerce.matriz_product_prices(environment,product_id,price_amount) VALUES ('test',$1,89)`, [id]);
  await db.pool.query(`INSERT INTO commerce.wholesale_stock(environment,measure,brand,tire_condition,quantity_on_hand,unit_cost)
    VALUES ('test',$1,'Pirelli','meia_vida',5,40)`, [measure]);
  return id as string;
}
async function tool(conversationId: string, name: string, args: Record<string, unknown>, requestId = randomUUID()) {
  const client = await db.pool.connect();
  try {
    if (name === 'criar_pedido') await client.query('BEGIN');
    const result = JSON.parse(await tools.executeTool(client, 'test', conversationId, name, args, undefined, { triggerMessageId: requestId }));
    if (name === 'criar_pedido') await client.query('COMMIT');
    return result;
  } catch (e) { await client.query('ROLLBACK').catch(() => undefined); throw e; } finally { client.release(); }
}
const order = (c: string, p: string) => tool(c, 'criar_pedido', { nome_cliente: 'Joao Cliente', modalidade: 'pickup',
  forma_pagamento: 'pix', itens: [{ product_id: p, quantidade: 2, preco_unitario: 89 }] });
async function stock(measure: string) {
  return (await db.pool.query(`SELECT quantity_on_hand,quantity_reserved FROM commerce.wholesale_stock WHERE environment='test' AND measure=$1`, [measure])).rows[0];
}

describe('auditoria do bot', () => {
  it('expira somente reserva do bot após 24h, sem duplicar baixa ou atingir cliente na loja', async () => {
    const c = await conversation();
    const p = await product('130/80-18');
    const first = await order(c, p);
    const { expireBotReservations } = await import('../../src/operation/bot-reservations.js');
    const id = (await db.pool.query(`SELECT id FROM commerce.orders WHERE environment='test' AND order_number=$1`, [first.order_number])).rows[0].id;
    const at23 = new Date(Date.now()+23*3_600_000);
    expect(await expireBotReservations('test', db.pool, at23)).toBe(0);
    const at25 = new Date(Date.now()+25*3_600_000);
    expect(await expireBotReservations('test', db.pool, at25)).toBe(1);
    expect(await expireBotReservations('test', db.pool, at25)).toBe(0);
    expect((await stock('130/80-18')).quantity_reserved).toBe(0);
    expect((await db.pool.query(`SELECT count(*)::int n FROM finance.matriz_ledger_transactions WHERE source_id=$1`, [id])).rows[0].n).toBe(0);
    const arrived = await order(c, p);
    await db.pool.query(`UPDATE commerce.orders SET pickup_arrived_at=now() WHERE environment='test' AND order_number=$1`, [arrived.order_number]);
    expect(await expireBotReservations('test', db.pool, at25)).toBe(0);
    expect((await stock('130/80-18')).quantity_reserved).toBe(2);
  });
  it('retry antigo apos cancelamento nao reabre reserva; nova solicitacao abre e deduplica', async () => {
    const c = await conversation();
    const p = await product('120/80-18');
    const requestId = randomUUID();
    const args = { nome_cliente: 'Joao Cliente', modalidade: 'pickup', forma_pagamento: 'pix',
      itens: [{ product_id: p, quantidade: 2, preco_unitario: 89 }] };
    const first = await tool(c, 'criar_pedido', args, requestId);
    const duplicate = await tool(c, 'criar_pedido', args, requestId);
    expect(duplicate.order_number).toBe(first.order_number);
    await tool(c, 'cancelar_pedido', { order_number: first.order_number, motivo: 'desistiu' });
    const stale = await tool(c, 'criar_pedido', args, requestId);
    expect(stale.ok).not.toBe(true);
    expect(stale.erro).toBe('pedido_desta_solicitacao_encerrado');
    expect((await stock('120/80-18')).quantity_reserved).toBe(0);
    const freshId = randomUUID();
    const fresh = await tool(c, 'criar_pedido', args, freshId);
    expect(fresh.ok).toBe(true);
    expect(fresh.order_number).not.toBe(first.order_number);
    const anotherMessage = await tool(c, 'criar_pedido', args, randomUUID());
    expect(anotherMessage.order_number).toBe(fresh.order_number);
    expect((await stock('120/80-18')).quantity_reserved).toBe(2);
  });
  it('cliente cancela e depois pede de novo os mesmos 2 pneus na mesma conversa', async () => {
    const c = await conversation();
    const p = await product('90/90-18');
    const first = await order(c, p);
    const cancel = await tool(c, 'cancelar_pedido', { order_number: first.order_number, motivo: 'desistiu' });
    const second = await order(c, p);
    const rows = (await db.pool.query(`SELECT order_number,status FROM commerce.orders WHERE environment='test' AND source_conversation_id=$1 ORDER BY created_at`, [c])).rows;
    console.log('PEDE DE NOVO APOS CANCELAR:', JSON.stringify({ primeiro: first.order_number, cancelou: cancel.ok,
      resposta_ao_cliente: second.mensagem, pedidos_no_banco: rows, estoque: await stock('90/90-18') }));
    expect.soft(second.order_number).not.toBe(first.order_number);
    expect.soft((await stock('90/90-18')).quantity_reserved).toBe(2);
  });

  it('cliente que ja RETIROU pede de novo os mesmos 2 pneus', async () => {
    const c = await conversation();
    const p = await product('100/80-18');
    const first = await order(c, p);
    const id = (await db.pool.query(`SELECT id FROM commerce.orders WHERE environment='test' AND order_number=$1`, [first.order_number])).rows[0].id;
    const { completeMatrizPickup } = await import('../../src/admin/painel/queries-pedidos-acoes.js');
    await completeMatrizPickup({ order_id: id, actor_label: 'owner:aud', environment: 'test', payment_method: 'pix' }, db.pool);
    const second = await order(c, p);
    console.log('PEDE DE NOVO APOS RETIRAR:', JSON.stringify({ primeiro: first.order_number, resposta_ao_cliente: second.mensagem,
      estoque: await stock('100/80-18') }));
    expect.soft(second.order_number).not.toBe(first.order_number);
  });

  it('bot cancela no mesmo instante em que a loja conclui a retirada', async () => {
    const c = await conversation();
    const measure = '110/90-17';
    const p = await product(measure);
    const created = await order(c, p);
    const id = (await db.pool.query(`SELECT id FROM commerce.orders WHERE environment='test' AND order_number=$1`, [created.order_number])).rows[0].id;
    const { completeMatrizPickup } = await import('../../src/admin/painel/queries-pedidos-acoes.js');
    // Segura a linha do estoque para a retirada parar no meio (pedido ja travado e 'paid' nao commitado).
    const holder = await db.pool.connect();
    await holder.query('BEGIN');
    await holder.query(`SELECT 1 FROM commerce.wholesale_stock WHERE environment='test' AND measure=$1 FOR UPDATE`, [measure]);
    const pickup = completeMatrizPickup({ order_id: id, actor_label: 'balcao', environment: 'test', payment_method: 'pix' }, db.pool)
      .then(() => 'retirada ok', (e: Error) => `retirada erro: ${e.message}`);
    const holderPid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    const pickupPid = await waitForDatabaseBlock(db.pool, holderPid);
    const botCancel = tool(c, 'cancelar_pedido', { order_number: created.order_number, motivo: 'desistiu' });
    await waitForDatabaseBlock(db.pool, pickupPid);
    await holder.query('COMMIT'); holder.release();
    const [pickupResult, cancelResult] = await Promise.all([pickup, botCancel]);
    const final = (await db.pool.query(`SELECT status,retrieved_at IS NOT NULL retirado FROM commerce.orders WHERE id=$1`, [id])).rows[0];
    const ledger = (await db.pool.query(`SELECT e.account_code, sum(CASE e.side WHEN 'debit' THEN e.amount ELSE -e.amount END)::text net
      FROM finance.matriz_ledger_transactions t JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id
      WHERE t.environment='test' AND t.source_id=$1 GROUP BY 1 ORDER BY 1`, [id])).rows;
    console.log('CANCELA x RETIRADA:', JSON.stringify({ pickupResult, bot: cancelResult.mensagem ?? cancelResult.erro,
      pedido: final, estoque: await stock(measure), livro: ledger }));
    // Correto: uma das duas vence. Se a retirada venceu, o bot NAO pode cancelar um pedido ja retirado.
    expect(pickupResult).toBe('retirada ok');
    expect(final).toMatchObject({ status: 'paid', retirado: true });
    expect(cancelResult.ok).not.toBe(true);
    expect((await stock(measure)).quantity_reserved).toBe(0);
    expect((await stock(measure)).quantity_on_hand).toBe(3);
    expect(ledger.some(row => row.account_code === 'customer_refund_payable')).toBe(false);
  });
});

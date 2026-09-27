import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';
import { loadHistory } from '../../src/atendente-v2/history.js';
import { loadConversationPhotoStatus } from '../../src/atendente-v2/photo-status.js';

let db: IntegrationDb, unit: string, product: string, seq = 991000;
let execute: typeof import('../../src/atendente-v2/tools.js').executeTool;
beforeAll(async () => {
  db = await startPostgres();
  Object.assign(process.env, { NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: db.connectionString,
    CHATWOOT_HMAC_SECRET: 'test', ADMIN_AUTH_TOKEN: 'test', PICKUP_TO_PARTNER: 'false',
    PHOTO_REQUESTS: 'true', BOT_AUDIO_ENABLED: 'false', MATRIZ_CENTRAL_LEDGER: 'true',
    WHOLESALE_UNIFIED_STOCK: 'true', WHOLESALE_MATRIZ_DECREMENT: 'true',
    WHOLESALE_MATRIZ_RETAIL_COST: 'true', WHOLESALE_MATRIZ_OVERSELL_GUARD: 'true' });
  vi.stubGlobal('fetch', vi.fn(() => { throw Error('Rede externa proibida neste teste'); }));
  execute = (await import('../../src/atendente-v2/tools.js')).executeTool;
  unit = (await db.pool.query(`INSERT INTO core.units(environment,slug,name,is_active) VALUES('test','main','Matriz',true)
    ON CONFLICT(environment,slug) DO UPDATE SET is_active=true RETURNING id`)).rows[0].id;
  product = (await db.pool.query(`INSERT INTO commerce.products(environment,product_code,product_name,product_type,brand,tire_condition)
    VALUES('test','PHONE-TEST','Pneu 90/90-18','tire','Pirelli','meia_vida') RETURNING id`)).rows[0].id;
  await db.pool.query(`INSERT INTO commerce.tire_specs(environment,product_id,tire_size) VALUES('test',$1,'90/90-18')`, [product]);
  await db.pool.query(`INSERT INTO commerce.wholesale_stock(environment,measure,brand,tire_condition,quantity_on_hand,unit_cost)
    VALUES('test','90/90-18','Pirelli','meia_vida',30,20)`);
  await db.pool.query(`INSERT INTO commerce.matriz_product_prices(environment,product_id,price_amount) VALUES('test',$1,89)`, [product]);
}, 180000);
afterAll(async () => { vi.unstubAllGlobals(); if (db) await stopPostgres(db); });

async function fixture(phone: string | null = null) {
  const contact = (await db.pool.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name,phone_e164)
    VALUES('test',$1,'Cliente teste',$2) RETURNING id`, [++seq, phone])).rows[0].id;
  const conversation = (await db.pool.query(`INSERT INTO core.conversations(environment,chatwoot_conversation_id,chatwoot_account_id,
    contact_id,current_status,started_at) VALUES('test',$1,1,$2,'open',now()) RETURNING id,chatwoot_conversation_id`, [++seq, contact])).rows[0];
  return { contact, conversation: conversation.id as string, chatwootId: conversation.chatwoot_conversation_id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function message(f: Fixture, content: string, sender = 'contact', isPrivate = false) {
  return (await db.pool.query(`INSERT INTO core.messages
    (environment,conversation_id,chatwoot_conversation_id,chatwoot_message_id,sender_type,message_type,is_private,content,sent_at)
    VALUES('test',$1,$2,$3,$4,$5,$6,$7,clock_timestamp()) RETURNING id`,
    [f.conversation, f.chatwootId, ++seq, sender, sender === 'contact' ? 0 : 1, isPrivate, content])).rows[0].id;
}
async function close(f: Fixture, args: Record<string, unknown> = {}, environment: 'prod' | 'test' = 'test') {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const result = JSON.parse(await execute(client, environment, f.conversation, 'criar_pedido', {
      itens: [{ product_id: product, quantidade: 1, preco_unitario: 89 }],
      modalidade: 'pickup', nome_cliente: 'Maria Teste', forma_pagamento: 'pix', ...args,
    }));
    await client.query('COMMIT');
    return result;
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
async function state() {
  return {
    orders: (await db.pool.query('SELECT count(*)::int AS count FROM commerce.orders')).rows[0].count,
    stock: (await db.pool.query(`SELECT quantity_on_hand,quantity_reserved FROM commerce.wholesale_stock WHERE environment='test'`)).rows,
    facts: (await db.pool.query('SELECT count(*)::int AS count FROM finance.matriz_ledger_transactions')).rows[0].count,
  };
}

describe('fechamento nas redes sociais: telefone e fotos', () => {
  it('não cria pedido quando o nome é um apelido automático do Chatwoot', async () => {
    const f = await fixture('+5521999991111');
    const before = await state();
    expect(await close(f, { nome_cliente: 'lively-bush-319' })).toMatchObject({ erro: 'nome_cliente_obrigatorio' });
    expect(await state()).toEqual(before);
    expect(await close(f, { nome_cliente: '2W Log' })).toMatchObject({ ok: true });
  });
  it.each([undefined, '2198765565', '21998765565'])('não cria pedido/reserva/financeiro com telefone %s', async phone => {
    const f = await fixture();
    await message(f, 'Rua Exemplo 38 2198765565 vou pagar no pix');
    const before = await state();
    expect(await close(f, { telefone_cliente: phone })).toMatchObject({ erro: 'telefone_obrigatorio' });
    expect(await state()).toEqual(before);
  });
  it('não aproveita telefone do bot, nota privada ou outra conversa', async () => {
    const f = await fixture(), other = await fixture();
    await message(f, '21999991111', 'user');
    await message(f, '21999991111', 'contact', true);
    await message(other, '21999991111');
    expect(await close(f, { telefone_cliente: '21999991111' })).toMatchObject({ erro: 'telefone_obrigatorio' });
  });
  it('grava telefone confirmado na Matriz, expõe na venda e não reescreve o contato do Instagram', async () => {
    const f = await fixture();
    await message(f, 'Rua Exemplo 38 (21) 99999-1111 vou pagar no pix');
    const result = await close(f, { telefone_cliente: '21999991111' });
    expect(result).toMatchObject({ ok: true, total: '89.00' });
    const row = (await db.pool.query(`SELECT o.customer_phone,pr.contact_phone,c.phone_e164
      FROM commerce.orders o JOIN dashboard.pedidos_recentes pr ON pr.order_id=o.id AND pr.environment=o.environment
      JOIN core.contacts c ON c.id=o.contact_id WHERE o.environment='test' AND o.source_conversation_id=$1`, [f.conversation])).rows[0];
    expect(row).toEqual({ customer_phone: '+5521999991111', contact_phone: '+5521999991111', phone_e164: null });
    const before = await state();
    expect(await close(f, { telefone_cliente: '21999991111' })).toMatchObject({ order_number: result.order_number });
    expect(await state()).toEqual(before);
  });
  it('continua fechando WhatsApp com telefone válido já cadastrado', async () => {
    expect(await close(await fixture('+5521999991111'))).toMatchObject({ ok: true });
    expect(await close(await fixture('+552198765565'))).toMatchObject({ erro: 'telefone_obrigatorio' });
  });
  it('não cria sem forma de pagamento nem cruza ambientes', async () => {
    const f = await fixture('+5521999991111');
    const before = await state();
    expect(await close(f, { forma_pagamento: undefined })).toMatchObject({ erro: 'pagamento_obrigatorio' });
    expect((await close(f, {}, 'prod')).erro).toBeDefined();
    expect(await state()).toEqual(before);
  });
  it('mantém imagem sem legenda no histórico e consulta o envio atual ao fechar', async () => {
    const f = await fixture('+5521999991111');
    await message(f, 'Tem uma foto dele aí?');
    const id = await message(f, '', 'user');
    await db.pool.query(`INSERT INTO core.message_attachments(environment,chatwoot_attachment_id,message_id,conversation_id,file_type)
      VALUES('test',$1,$2,$3,'image')`, [++seq, id, f.conversation]);
    await db.pool.query(`INSERT INTO commerce.photo_requests(environment,unit_id,conversation_id,tire_size,status,answered_at,sent_to_customer_at)
      VALUES('test',$1,$2,'90/90-18','sent',now(),now())`, [unit, f.chatwootId]);
    await message(f, 'Show vou querer');
    const client = await db.pool.connect();
    try {
      const history = await loadHistory(client, f.conversation);
      expect(history.map(m => m.role)).toEqual(['user', 'assistant', 'user']);
      expect(history[1]?.content).toContain('A loja enviou uma imagem');
      expect(await loadConversationPhotoStatus(client, 'prod', f.conversation)).toEqual([]);
    } finally { client.release(); }
    const result = await close(f);
    expect(result).toMatchObject({ ok: true, fotos: [{ medida: '90/90-18', status: 'sent', enviada_em: expect.any(String) }] });
  });
});

import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';
import { atOpenStoreTime, configureTestOpeningHours } from './helpers/store-opening-fixtures.js';

const measure = '245/40-18';
const brand = 'Pneu QA Conferido';
const model = 'Modelo QA';
const location = 'QA-FUNDO-22';
const movedLocation = 'QA-PORTA-17';
const searchArgs = { medida_pneu: measure, municipio: 'Rio de Janeiro', bairro: 'Centro', modalidade: 'pickup' };
const customerName = 'Rafael Silva';
const confirmedOfferText = 'Tenho o par desta medida por R$ 220,00. Quer levar o par?';
let db: IntegrationDb;
let serial = 9962500;
let execute: typeof import('../../src/atendente-v2/tools.js').executeTool;
let stockGroups: typeof import('../../src/admin/painel/stock-groups.js');

beforeAll(async () => {
  db = await startPostgres();
  await configureTestOpeningHours(db.pool);
  Object.assign(process.env, {
    NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: db.connectionString,
    CHATWOOT_HMAC_SECRET: 'test', ADMIN_AUTH_TOKEN: 'test', ROUTING_GEO: 'false',
    PICKUP_TO_PARTNER: 'false', PARTNER_STOCK_CONFIRMATION: 'false', BOT_OUTBOX: 'true',
    WHOLESALE_UNIFIED_STOCK: 'true', WHOLESALE_MATRIZ_DECREMENT: 'true',
    WHOLESALE_MATRIZ_OVERSELL_GUARD: 'true', WHOLESALE_MATRIZ_RETAIL_COST: 'true',
    MATRIZ_CAR_GROUP_OFFERS: 'true', MATRIZ_MARKET_REFERENCE_OBJECTIONS: 'true',
  });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Rede externa proibida'); }));
  ({ executeTool: execute } = await import('../../src/atendente-v2/tools.js'));
  stockGroups = await import('../../src/admin/painel/stock-groups.js');
  await db.pool.query("INSERT INTO core.units(environment,slug,name) VALUES ('test','main','Matriz') ON CONFLICT DO NOTHING");
}, 180_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  if (db) await stopPostgres(db);
});

async function product(productBrand: string, quantity: number, size = measure, vehicleType: 'car' | 'motorcycle' | null = 'car') {
  const items = await db.pool.query<{ id: string }>(`INSERT INTO commerce.products
    (environment,product_code,product_name,product_type,brand,tire_condition)
    VALUES ('test',$1,$2,'tire',$2,'meia_vida') RETURNING id`, [randomUUID(), productBrand]);
  const productId = items.rows[0]!.id;
  await db.pool.query(`INSERT INTO commerce.tire_specs
    (environment,product_id,tire_size,width_mm,aspect_ratio,rim_diameter,vehicle_type,tread_pattern)
    VALUES ('test',$1,$2,$3,$4,18,$5,$6)`, [productId, size, ...size.match(/[0-9]+/g)!.slice(0, 2).map(Number), vehicleType, model]);
  await db.pool.query(`INSERT INTO commerce.matriz_product_prices(environment,product_id,price_amount)
    VALUES ('test',$1,110)`, [productId]);
  const stock = await db.pool.query<{ id: string }>(`INSERT INTO commerce.wholesale_stock
    (environment,measure,brand,tire_condition,quantity_on_hand,unit_cost,vehicle_type)
    VALUES ('test',$1,$2,'meia_vida',$3,80,$4) RETURNING id`, [size, productBrand, quantity, vehicleType]);
  return { productId, stockId: stock.rows[0]!.id };
}

async function conversation() {
  const contact = await db.pool.query<{ id: string }>(`INSERT INTO core.contacts
    (environment,chatwoot_contact_id,name,phone_e164) VALUES ('test',$1,$2,'+5521999990456') RETURNING id`,
  [++serial, customerName]);
  return (await db.pool.query<{ id: string }>(`INSERT INTO core.conversations
    (environment,chatwoot_account_id,chatwoot_conversation_id,contact_id,current_status,started_at)
    VALUES ('test',1,$1,$2,'open',now()) RETURNING id`, [++serial, contact.rows[0]!.id])).rows[0]!.id;
}

async function customerMessage(conversationId: string, body: string) {
  return (await db.pool.query<{ id: string }>(`INSERT INTO core.messages
    (environment,conversation_id,chatwoot_conversation_id,chatwoot_message_id,sender_type,message_type,is_private,content,sent_at)
    SELECT 'test',id,chatwoot_conversation_id,$2,'contact',0,false,$3,clock_timestamp()
    FROM core.conversations WHERE id=$1 RETURNING id`, [conversationId, ++serial, body])).rows[0]!.id;
}

async function call(conversationId: string, triggerMessageId: string, name: string, args: Record<string, unknown>) {
  const client = await db.pool.connect();
  try {
    if (name === 'criar_pedido') await client.query('BEGIN');
    const result = await atOpenStoreTime(() => execute(client, 'test', conversationId, name, args, undefined, { triggerMessageId }));
    if (name === 'criar_pedido') await client.query('COMMIT');
    return JSON.parse(result);
  } catch (error) {
    if (name === 'criar_pedido') await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function acknowledgeQuote(conversationId: string, triggerId: string, args: Record<string, unknown>, result: unknown,
  deliveredText = confirmedOfferText, draftText = deliveredText) {
  const toolCall = 'search-' + triggerId;
  const actions = result === undefined ? [] : [{ role: 'assistant', content: null, tool_calls: [{ id: toolCall, type: 'function',
    function: { name: 'buscar_produto', arguments: JSON.stringify(args) } }] },
  { role: 'tool', tool_call_id: toolCall, content: JSON.stringify(result) }];
  const providerId = ++serial;
  const turn = await db.pool.query<{ id: string }>(`INSERT INTO agent.turns
    (environment,conversation_id,trigger_message_id,agent_version,context_hash,say_text,actions,status,chatwoot_message_id)
    VALUES ('test',$1,$2,'v2','',$3,$4::jsonb,'sent_api_ack',$5) RETURNING id`,
  [conversationId, triggerId, draftText, JSON.stringify(actions), providerId]);
  await db.pool.query(`INSERT INTO ops.outbound_messages
    (environment,conversation_id,trigger_message_id,turn_id,chatwoot_conversation_id,provider_message_id,kind,body,body_sha256,status,sent_at)
    SELECT 'test',id,$2,$3,chatwoot_conversation_id,$4,'agent_text',$5,$6,'sent_api_ack',clock_timestamp()
    FROM core.conversations WHERE id=$1`, [conversationId, triggerId, turn.rows[0]!.id, providerId,
    deliveredText, createHash('sha256').update(deliveredText).digest('hex')]);
}

async function confirmedPair(conversationId: string, orderNumber: string) {
  return (await db.pool.query<{ id: string; quantity: number; product_id: string }>(`SELECT o.id,i.quantity,i.product_id
    FROM commerce.orders o JOIN commerce.order_items i ON i.environment=o.environment AND i.order_id=o.id
    WHERE o.environment='test' AND o.source_conversation_id=$1 AND o.order_number=$2`, [conversationId, orderNumber])).rows[0];
}

it('oferece um par confirmado após o décimo SKU, rejeita revisão antiga e reserva apenas o grupo reconfirmado', async () => {
  for (let index = 1; index <= 10; index++) await product('Pneu QA Avulso ' + index, 10);
  const confirmed = await product(brand, 3);
  const group = await stockGroups.saveMatrizStockGroup(db.pool, 'test', {
    stock_id: confirmed.stockId, product_id: confirmed.productId, model, matched_set: true,
    inspection_status: 'approved', conservation_grade: 'selecionado', conservation_note: 'observação exclusiva da equipe QA',
    positions: [{ location_code: location, quantity: 2 }], reason: 'Par conferido', idempotency_key: randomUUID(),
  }, 'fixture');
  const conversationId = await conversation();
  const triggerId = await customerMessage(conversationId, 'Quero um par igual para meu carro, para retirar.');
  const generic = await call(conversationId, triggerId, 'buscar_produto', { ...searchArgs, tipo_veiculo: 'car' });
  expect(generic.produtos).toHaveLength(10);
  expect(generic.produtos.every((p: { product_id: string }) => p.product_id !== confirmed.productId)).toBe(true);
  expect(generic.conjunto_carro).toBeUndefined();
  const tooMany = await call(conversationId, triggerId, 'buscar_produto', {
    ...searchArgs, quantidade: 11, quer_conjunto: true,
  });
  expect(tooMany.quantidade_integral_disponivel).toBe(false);
  expect(tooMany.conjunto_carro).toBeUndefined();

  const pairArgs = { ...searchArgs, tipo_veiculo: 'car', quantidade: 2, quer_conjunto: true };
  const offer = await call(conversationId, triggerId, 'buscar_produto', pairArgs);
  expect(offer.produtos).toHaveLength(10);
  expect(offer.produtos[0].product_id).toBe(confirmed.productId);
  expect(offer.conjunto_carro).toMatchObject({
    conjunto_id: group.group_id, product_id: confirmed.productId, revisao: group.revision,
    quantidade: 2, preco_unitario: 110, total: 220, conservacao: 'selecionado',
  });
  expect(JSON.stringify(offer)).not.toContain(location);
  expect(JSON.stringify(offer)).not.toContain('observação exclusiva');
  const pickupArgs = { ...searchArgs, conjunto_id: group.group_id, product_ids: [confirmed.productId] };
  const checkoutArgs = { ...searchArgs, conjunto_id: group.group_id, forma_pagamento: 'pix',
    nome_cliente: customerName, itens: [{ product_id: confirmed.productId, quantidade: 2, preco_unitario: 110 }] };
  // O cliente pode responder apenas ao texto que foi enviado, inclusive quando o rascunho era diferente.
  await acknowledgeQuote(conversationId, triggerId, pairArgs, offer, 'Quer ver a foto do par?', confirmedOfferText);
  const wantsPhoto = await customerMessage(conversationId, 'Sim');
  expect(await call(conversationId, wantsPhoto, 'criar_pedido', checkoutArgs)).toMatchObject({ erro: 'conjunto_aceite_pendente' });
  await acknowledgeQuote(conversationId, wantsPhoto, pairArgs, offer, confirmedOfferText, 'Quer ver a foto do par?');
  const declined = await customerMessage(conversationId, 'Não vou levar o par.');
  expect(await call(conversationId, declined, 'criar_pedido', checkoutArgs)).toMatchObject({ erro: 'conjunto_aceite_pendente' });
  await acknowledgeQuote(conversationId, declined, pairArgs, offer, 'Quer levar o parzinho?', 'Quer ver a foto?');
  const accepted = await customerMessage(conversationId, 'Sim');
  expect(await call(conversationId, accepted, 'localizacao_loja', pickupArgs))
    .toMatchObject({ encontrado: true, conjunto_id: group.group_id });
  await stockGroups.moveMatrizStockGroup(db.pool, 'test', {
    group_id: group.group_id, revision: group.revision, from_location: location, to_location: movedLocation,
    quantity: 1, reason: 'Reorganização', idempotency_key: randomUUID(),
  }, 'fixture');
  expect(await call(conversationId, accepted, 'localizacao_loja', pickupArgs)).toMatchObject({ erro: 'stock_group_route_changed' });
  await expect(call(conversationId, accepted, 'criar_pedido', checkoutArgs)).rejects.toThrow('stock_group_offer_changed');
  const failedOrders = await db.pool.query("SELECT id FROM commerce.orders WHERE environment='test' AND source_conversation_id=$1", [conversationId]);
  expect(failedOrders.rows).toEqual([]);

  const renewed = await call(conversationId, accepted, 'buscar_produto', pairArgs);
  expect(renewed.conjunto_carro.revisao).not.toBe(group.revision);
  await acknowledgeQuote(conversationId, accepted, pairArgs, renewed);
  const renewedAcceptance = await customerMessage(conversationId, 'Quero levar o par.');
  const created = await call(conversationId, renewedAcceptance, 'criar_pedido', checkoutArgs);
  expect(created).toMatchObject({ ok: true, total: '220.00' });
  expect(JSON.stringify(created)).not.toContain(location);
  expect(JSON.stringify(created)).not.toContain(movedLocation);
  const order = await confirmedPair(conversationId, created.order_number);
  expect(order).toMatchObject({ quantity: 2, product_id: confirmed.productId });
  expect(await stockGroups.listMatrizOrderGroupPositions(db.pool, 'test', order!.id)).toMatchObject([
    { location_code: location, quantity: 1, status: 'reserved' },
    { location_code: movedLocation, quantity: 1, status: 'reserved' },
  ]);
});

it('sugere seis unidades só pela medida de carro confirmada e deixa o fluxo comum quando há SKU sem tipo', async () => {
  const size = '235/55-18';
  const confirmed = await product('Carro por medida QA', 8, size);
  const group = await stockGroups.saveMatrizStockGroup(db.pool, 'test', {
    stock_id: confirmed.stockId, product_id: confirmed.productId, model, matched_set: true,
    inspection_status: 'approved', positions: [{ location_code: location, quantity: 6 }],
    reason: 'Seis unidades conferidas', idempotency_key: randomUUID(),
  }, 'fixture');
  const conversationId = await conversation();
  const triggerId = await customerMessage(conversationId, 'Tem 235/55 R18?');
  const search = { ...searchArgs, medida_pneu: '235/55 R18' };
  const offer = await call(conversationId, triggerId, 'buscar_produto', search);
  expect(offer.conjunto_carro).toMatchObject({ conjunto_id: group.group_id, product_id: confirmed.productId, quantidade: 6 });
  expect(JSON.stringify(offer)).not.toContain(location);

  expect((await call(conversationId, triggerId, 'buscar_produto', { ...search, tipo_veiculo: 'motorcycle' })).conjunto_carro)
    .toBeUndefined();
  await product('Tipo desconhecido QA', 0, size, null);
  const ambiguous = await call(conversationId, triggerId, 'buscar_produto', search);
  expect(ambiguous).toMatchObject({ encontrado: true });
  expect(ambiguous.conjunto_carro).toBeUndefined();
});

it('usa referência só após a última cotação confirmada na outbox e uma objeção real', async () => {
  const size = '255/55-18';
  const item = await product('Marca QA Referência', 2, size);
  await stockGroups.saveMatrizStockGroup(db.pool, 'test', {
    stock_id: item.stockId, product_id: item.productId, model, matched_set: true,
    inspection_status: 'approved', positions: [{ location_code: location, quantity: 2 }],
    reason: 'Par de referência', idempotency_key: randomUUID(),
  }, 'fixture');
  const { setMarketReference } = await import('../../src/shared/catalog-market-reference.js');
  const today = `(now() AT TIME ZONE 'America/Sao_Paulo')::date`;
  const dates = await db.pool.query<{ observed_on: string; valid_until: string }>(`
    SELECT (${today})::text AS observed_on,(${today}+5)::text AS valid_until`);
  await setMarketReference({ product_id: item.productId, model, amount: 289, bot_enabled: true,
    sources: ['https://example.com/novo'], ...dates.rows[0]! }, 'fixture', 'test', db.pool);

  const conversationId = await conversation();
  const search = { ...searchArgs, medida_pneu: size, quantidade: 2, quer_conjunto: true };
  const lookup = async (message: string) => call(conversationId, await customerMessage(conversationId, message),
    'consultar_referencia_preco', { product_id: item.productId });
  const makeOffer = async (sentText: string, draftText: string) => {
    const trigger = await customerMessage(conversationId, 'Qual o preço do par 255/55 R18?');
    const result = await call(conversationId, trigger, 'buscar_produto', search);
    expect(result.conjunto_carro).toMatchObject({ product_id: item.productId, total: 220 });
    await acknowledgeQuote(conversationId, trigger, search, result, sentText, draftText);
  };
  await makeOffer('Achei essa medida no estoque.', confirmedOfferText);
  expect(await lookup('Achei caro.')).toEqual({ referencia_disponivel: false });

  await makeOffer(confirmedOfferText, 'Achei essa medida no estoque.');
  expect(await lookup('Quanto fica o frete?')).toEqual({ referencia_disponivel: false });
  expect(await lookup('Achei caro.')).toMatchObject({ referencia_disponivel: true, preco_online_novo: 289, tipo_da_referencia: 'cotacao' });

  const later = await customerMessage(conversationId, 'Você tem fotos?');
  await acknowledgeQuote(conversationId, later, search, undefined, 'Vou pedir a foto para a loja.');
  expect(await lookup('Achei caro.')).toEqual({ referencia_disponivel: false });
});

it('oferece e reconfirma o par da opção prioritária com mais de cem outros grupos na medida', async () => {
  const size = '275/40-18';
  const first = await product('Marca QA maior saldo', 304, size);
  const secondary = await product('Marca QA muitos grupos', 303, size);
  const pair = await stockGroups.saveMatrizStockGroup(db.pool, 'test', {
    stock_id: first.stockId, product_id: first.productId, model, matched_set: true,
    inspection_status: 'approved', positions: [{ location_code: location, quantity: 2 }],
    reason: 'Par conferido', idempotency_key: randomUUID(),
  }, 'fixture');
  await db.pool.query(`INSERT INTO commerce.matriz_stock_groups
    (environment,stock_id,product_id,model,inspection_status,matched_set)
    SELECT 'test',$1,$2,$3,'approved',true FROM generate_series(1,101)`,
  [secondary.stockId, secondary.productId, model]);
  await db.pool.query(`INSERT INTO commerce.matriz_stock_group_positions
    (environment,group_id,location_code,quantity_on_hand)
    SELECT environment,id,'OUTRA-PILHA',3 FROM commerce.matriz_stock_groups
    WHERE environment='test' AND product_id=$1`, [secondary.productId]);

  const conversationId = await conversation();
  const request = await customerMessage(conversationId, 'Quero um par nessa medida para retirar.');
  const args = { ...searchArgs, medida_pneu: size, tipo_veiculo: 'car', quantidade: 2, quer_conjunto: true };
  const offer = await call(conversationId, request, 'buscar_produto', args);
  expect(offer.conjunto_carro).toMatchObject({ conjunto_id: pair.group_id, product_id: first.productId, quantidade: 2 });
  expect(JSON.stringify(offer)).not.toContain(location);
  await acknowledgeQuote(conversationId, request, args, offer);
  const accepted = await customerMessage(conversationId, 'Quero levar o par.');
  const pickup = await call(conversationId, accepted, 'localizacao_loja', {
    ...searchArgs, medida_pneu: size, conjunto_id: pair.group_id, product_ids: [first.productId],
  });
  expect(pickup).toMatchObject({ encontrado: true, conjunto_id: pair.group_id });
});

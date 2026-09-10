import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { startPostgres, stopPostgres, applyMigrationFile, type IntegrationDb } from './helpers/postgres.js';
import { createPartnerFixture } from './helpers/partner-fixtures.js';

let db: IntegrationDb;
let tools: typeof import('../../src/atendente-v2/tools.js');
let fulfillment: typeof import('../../src/atendente-v2/fulfillment.js');
let getBotVisao: typeof import('../../src/admin/painel/queries-bot-visao.js').getBotVisao;
let getBotMedidasMunicipio: typeof import('../../src/admin/painel/queries-bot-demanda.js').getBotMedidasMunicipio;
let oldConversation: Awaited<ReturnType<typeof conversation>>;
let serial = 981800;

async function conversation(environment = 'test') {
  const cw = ++serial;
  const contact = (await db.pool.query(
    `INSERT INTO core.contacts(environment,chatwoot_contact_id,name,phone_e164)
     VALUES ($1,$2,'Cliente teste','+5521999990000') RETURNING id`, [environment, cw],
  )).rows[0].id;
  const id = (await db.pool.query(
    `INSERT INTO core.conversations(environment,chatwoot_conversation_id,chatwoot_account_id,
       contact_id,current_status,started_at,last_activity_at)
     VALUES ($1,$2,9818,$3,'open',now(),now()) RETURNING id`, [environment, cw, contact],
  )).rows[0].id;
  return { id, cw, environment, contact };
}

async function message(c: Awaited<ReturnType<typeof conversation>>) {
  return (await db.pool.query(
    `INSERT INTO core.messages(environment,chatwoot_message_id,conversation_id,chatwoot_conversation_id,
       sender_type,message_type,content,is_private,sent_at)
     VALUES ($1,$2,$3,$4,'contact',0,'consulta teste',false,now()) RETURNING id`,
    [c.environment, ++serial, c.id, c.cw],
  )).rows[0].id as string;
}

function quoteActions(result: unknown = {
  encontrado: true,
  produtos: [{ product_name: 'Pneu teste', tire_size: '90/90-12', price_amount: '89.00' }],
}) {
  return [
    { role: 'assistant', tool_calls: [{ id: 'quote', type: 'function', function: {
      name: 'buscar_produto', arguments: JSON.stringify({ medida_pneu: '90/90-12' }),
    } }] },
    { role: 'tool', tool_call_id: 'unrelated', content: JSON.stringify({ encontrado: false }) },
    { role: 'tool', tool_call_id: 'quote', content: typeof result === 'string' ? result : JSON.stringify(result) },
  ];
}

function leadLocationActions() {
  return [
    { role: 'assistant', tool_calls: [{ id: 'lead-location', type: 'function', function: {
      name: 'registrar_localizacao_lead', arguments: JSON.stringify({
        texto_informado: 'Rua 43, Itaipuaçu, Maricá', tipo: 'endereco_digitado',
        rua: 'Rua 43', bairro: 'Itaipuaçu', municipio: 'Maricá',
      }),
    } }] },
    { role: 'tool', tool_call_id: 'lead-location', content: JSON.stringify({ ok: true }) },
  ];
}

async function turn(c: Awaited<ReturnType<typeof conversation>>, actions = quoteActions(), status = 'delivered') {
  const msg = await message(c);
  return (await db.pool.query(
    `INSERT INTO agent.turns(environment,conversation_id,trigger_message_id,agent_version,
       context_hash,status,actions) VALUES ($1,$2,$3::uuid,'v2',$3::text,$4,$5::jsonb) RETURNING id`,
    [c.environment, c.id, msg, status, JSON.stringify(actions)],
  )).rows[0].id as string;
}

async function pin(c: Awaited<ReturnType<typeof conversation>>, lat = -23, lng = -43, city: string | null = 'Maricá') {
  const msg = await message(c);
  await db.pool.query(
    `INSERT INTO core.message_attachments(environment,chatwoot_attachment_id,message_id,
       conversation_id,file_type,coordinates_lat,coordinates_lng)
     VALUES ($1,$2,$3,$4,'location',$5,$6)`, [c.environment, ++serial, msg, c.id, lat, lng],
  );
  if (city) await db.pool.query(
    `INSERT INTO commerce.geo_cache(cache_key,kind,value) VALUES ($1,'reverse',$2::jsonb)
     ON CONFLICT(cache_key) DO UPDATE SET value=EXCLUDED.value`,
    [`r:${lat.toFixed(4)},${lng.toFixed(4)}`, JSON.stringify({ municipio: city, neighborhood: 'Bairro teste' })],
  );
}

async function quotedFacts(id: string) {
  return (await db.pool.query(
    `SELECT id,fact_key,fact_value FROM analytics.conversation_facts
     WHERE conversation_id=$1 AND extractor_version='sql_product_quote_v1_2026-09-06'
     ORDER BY fact_key`, [id],
  )).rows;
}

async function stage(id: string) {
  return (await db.pool.query(
    `SELECT value FROM analytics.conversation_classifications WHERE conversation_id=$1
     AND dimension='stage_reached' AND extractor_version='sql_v1_2026-05-26'`, [id],
  )).rows[0]?.value;
}

beforeAll(async () => {
  db = await startPostgres({ throughMigration: '0216_conversation_bot_control.sql' });
  Object.assign(process.env, {
    NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: db.connectionString,
    CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'test-admin-token',
    ROUTING_GEO: 'true', PICKUP_TO_PARTNER: 'true', GOOGLE_MAPS_API_KEY: 'fixture-no-network',
    WHOLESALE_UNIFIED_STOCK: 'true', WHOLESALE_MATRIZ_DECREMENT: 'true',
    WHOLESALE_MATRIZ_OVERSELL_GUARD: 'true', WHOLESALE_MATRIZ_RETAIL_COST: 'true',
    MATRIZ_CENTRAL_LEDGER: 'true', PHOTO_REQUESTS: 'false', GEO_CACHE: 'true',
  });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Rede externa proibida neste teste'); }));
  tools = await import('../../src/atendente-v2/tools.js');
  fulfillment = await import('../../src/atendente-v2/fulfillment.js');
  ({ getBotVisao } = await import('../../src/admin/painel/queries-bot-visao.js'));
  ({ getBotMedidasMunicipio } = await import('../../src/admin/painel/queries-bot-demanda.js'));
  oldConversation = await conversation();
  await turn(oldConversation);
  expect(await stage(oldConversation.id)).toBe('abriu_conversa');
  await applyMigrationFile(db.pool, '0217_bot_order_customer_name.sql');
  await applyMigrationFile(db.pool, '0218_bot_quote_and_demand_analytics.sql');
  await applyMigrationFile(db.pool, '0220_lead_location_memory.sql');
  await applyMigrationFile(db.pool, '0221_bot_analytics_trigger_isolation.sql');
  await applyMigrationFile(db.pool, '0223_matriz_delivery_settings.sql');
}, 180_000);

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  vi.unstubAllGlobals();
  if (db) await stopPostgres(db);
});

describe('cotação e mapa de demanda', () => {
  it('recupera a cotação antiga e reaplica migrations sem duplicar facts/evidências', async () => {
    expect(await stage(oldConversation.id)).toBe('recebeu_cotacao');
    const before = await quotedFacts(oldConversation.id);
    expect(before).toHaveLength(3);
    await applyMigrationFile(db.pool, '0217_bot_order_customer_name.sql');
    await applyMigrationFile(db.pool, '0218_bot_quote_and_demand_analytics.sql');
    await applyMigrationFile(db.pool, '0220_lead_location_memory.sql');
    await applyMigrationFile(db.pool, '0221_bot_analytics_trigger_isolation.sql');
    expect(await quotedFacts(oldConversation.id)).toEqual(before);
    const evidence = await db.pool.query(
      `SELECT count(*)::int n FROM analytics.fact_evidence WHERE fact_id=ANY($1::uuid[])`,
      [before.map(f => f.id)],
    );
    expect(evidence.rows[0].n).toBe(3);
  });

  it('avança só após entrega confirmada e mantém replay idempotente', async () => {
    const c = await conversation();
    const id = await turn(c, quoteActions(), 'generated');
    expect(await quotedFacts(c.id)).toHaveLength(0);
    await db.pool.query(`UPDATE agent.turns SET status='delivered' WHERE id=$1`, [id]);
    expect(await stage(c.id)).toBe('recebeu_cotacao');
    const before = await quotedFacts(c.id);
    await db.pool.query(`SELECT analytics.extract_product_quote_facts($1)`, [id]);
    await db.pool.query(`UPDATE agent.turns SET status='delivered' WHERE id=$1`, [id]);
    expect(await quotedFacts(c.id)).toEqual(before);
    const panel = await getBotVisao('today', 'test', db.pool);
    expect(panel.funil.find(f => f.etapa === 'recebeu_cotacao')?.n).toBeGreaterThanOrEqual(2);
  });

  it.each([
    { encontrado: false, produtos: [{ price_amount: '89.00' }] },
    { encontrado: true, erro: 'falhou', produtos: [{ price_amount: '89.00' }] },
    { encontrado: true, produtos: [{ product_name: 'Sem preço', price_amount: null }] },
    { encontrado: true, produtos: [{ price_amount: 'NaN' }] },
    { encontrado: true, produtos: null },
    'resposta inválida',
  ])('não transforma consulta sem preço/erro em cotação: %j', async result => {
    const c = await conversation();
    await turn(c, quoteActions(result));
    expect(await quotedFacts(c.id)).toHaveLength(0);
    expect(await stage(c.id)).not.toBe('recebeu_cotacao');
  });

  it('pino resolvido aparece no mapa sem frete/pedido, inclusive o histórico', async () => {
    await pin(oldConversation);
    const panel = await getBotVisao('today', 'test', db.pool);
    expect(panel.mapa.find(r => r.municipio === 'Maricá')).toMatchObject({ chamou: 1, pediu: 0 });
    expect((await db.pool.query(
      `SELECT fact_key FROM analytics.conversation_facts WHERE conversation_id=$1
       AND fact_key IN ('municipio_entrega','taxa_frete_cotada','pedido_criado')`, [oldConversation.id],
    )).rows).toHaveLength(0);
  });

  it('localização digitada vira memória estimada e mapa sem fechar pedido', async () => {
    const c = await conversation();
    const id = await turn(c, leadLocationActions(), 'generated');
    expect((await db.pool.query(
      `SELECT id FROM analytics.conversation_facts WHERE conversation_id=$1 AND fact_key='localizacao_lead'`,
      [c.id],
    )).rows).toHaveLength(0);
    await db.pool.query(`UPDATE agent.turns SET status='delivered' WHERE id=$1`, [id]);
    const replay = await db.pool.query<{ total:number }>(
      `SELECT analytics.extract_lead_location_facts($1)::int AS total`, [id],
    );
    expect(replay.rows[0].total).toBe(0);
    const facts = (await db.pool.query(
      `SELECT id,fact_value,truth_type,source,confidence_level,extractor_version
         FROM analytics.conversation_facts
        WHERE conversation_id=$1 AND fact_key='localizacao_lead'`, [c.id],
    )).rows;
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      fact_value:{ texto_informado:'Rua 43, Itaipuaçu, Maricá',tipo:'endereco_digitado',
        rua:'Rua 43',bairro:'Itaipuaçu',municipio:'Maricá' },
      truth_type:'inferred',source:'llm_tool_call_v2',extractor_version:'llm_tool_lead_location_v1_2026-09-08',
    });
    expect(Number(facts[0].confidence_level)).toBe(0.9);
    expect((await db.pool.query(
      `SELECT municipio FROM analytics.v_bot_demand_location WHERE conversation_id=$1`, [c.id],
    )).rows[0].municipio).toBe('Maricá');
    expect((await db.pool.query(
      `SELECT evidence_text,evidence_type FROM analytics.fact_evidence WHERE fact_id=$1`, [facts[0].id],
    )).rows).toEqual([{ evidence_text:'Rua 43, Itaipuaçu, Maricá',evidence_type:'inferred' }]);
    await db.pool.query(`SELECT analytics.extract_lead_location_facts($1)`, [id]);
    expect((await db.pool.query(
      `SELECT id FROM analytics.conversation_facts WHERE conversation_id=$1 AND fact_key='localizacao_lead'`,
      [c.id],
    )).rows).toHaveLength(1);
  });

  it('pino novo não resolvido não reaproveita a cidade antiga; cache tardio corrige sem replay', async () => {
    const c = await conversation();
    await turn(c);
    await pin(c, -22.1, -42.1, 'Niterói');
    await pin(c, -22.2, -42.2, null);
    const location = () => db.pool.query(
      `SELECT municipio FROM analytics.v_bot_demand_location WHERE environment='test' AND conversation_id=$1`, [c.id],
    );
    expect((await location()).rows[0].municipio).toBeNull();
    await db.pool.query(
      `INSERT INTO commerce.geo_cache(cache_key,kind,value)
       VALUES ('r:-22.2000,-42.2000','reverse','{"municipio":"Itaboraí"}')`,
    );
    expect((await location()).rows[0].municipio).toBe('Itaboraí');
    expect((await getBotVisao('today', 'test', db.pool)).mapa.find(r => r.municipio === 'Itaboraí')?.chamou).toBe(1);
  });

  it('preserva município do frete e separa ambientes nos indicadores', async () => {
    const c = await conversation('prod'); // Somente no Docker descartável.
    await turn(c);
    await pin(c, -21, -41, 'Cidade isolada');
    const c2 = await conversation();
    await turn(c2, []);
    await db.pool.query(
      `INSERT INTO analytics.conversation_facts(environment,conversation_id,fact_key,fact_value,
       observed_at,truth_type,source,extractor_version)
       VALUES ('test',$1,'municipio_entrega','"São Gonçalo"',now(),'observed','test','test')`, [c2.id],
    );
    const test = await getBotVisao('today', 'test', db.pool);
    expect(test.mapa.some(r => r.municipio === 'Cidade isolada')).toBe(false);
    expect(test.mapa.find(r => r.municipio === 'São Gonçalo')?.chamou).toBe(1);
    expect((await getBotVisao('today', 'prod', db.pool)).mapa).toEqual([
      { municipio: 'Cidade isolada', chamou: 1, pediu: 0, efetivou: 0, faltou: 0 },
    ]);
    expect((await getBotVisao('today', 'prod', db.pool)).sem_regiao).toBe(0);
  });
});

describe('medidas por município e saldo atual', () => {
  it('separa municípios e ambientes, deduplica conversas e soma marcas sem confundir zero com ausência', async () => {
    const { randomUUID } = await import('node:crypto');
    const fact = async (c: Awaited<ReturnType<typeof conversation>>, key: string, value: unknown, days = 0, superseded: string | null = null) => {
      return (await db.pool.query(
        `INSERT INTO analytics.conversation_facts(environment,conversation_id,fact_key,fact_value,
          observed_at,truth_type,source,extractor_version,superseded_by)
         VALUES ($1,$2,$3,$4::jsonb,now()-($5::int*interval '1 day'),'observed','test',$6,$7) RETURNING id`,
        [c.environment,c.id,key,JSON.stringify(value),days,randomUUID(),superseded],
      )).rows[0].id as string;
    };
    const a = await conversation(), b = await conversation(), other = await conversation(), prod = await conversation('prod');
    for (const c of [a,b,prod]) await fact(c, 'municipio_entrega', 'Saquarema');
    await fact(other, 'municipio_entrega', 'Cabo Frio');
    await fact(a, 'medida_consultada', '130/70-13');
    await fact(a, 'medida_consultada', '130/70-13'); // Duas buscas da mesma conversa.
    await fact(b, 'medida_consultada', '130/70-13');
    await fact(other, 'medida_consultada', '130/70-13');
    await fact(prod, 'medida_consultada', '130/70-13');
    const current = await fact(a, 'medida_consultada', '180/55-17');
    await fact(a, 'medida_consultada', '110/70-17', 0, current); // Corrigida.
    await fact(a, 'medida_consultada', '140/70-17', 8); // Fora dos sete dias.
    await fact(a, 'medida_consultada', '195/55-16'); // Sem saldo cadastrado.
    await fact(a, 'medida_consultada', { invalida: true });
    await db.pool.query(
      `INSERT INTO commerce.wholesale_stock(environment,measure,brand,tire_condition,quantity_on_hand,unit_cost)
       VALUES ('test','130/70-13','Demanda A','novo',3,10),
              ('test','130/70-13','Demanda B','novo',7,10),
              ('test','180/55-17','Demanda A','novo',0,10),
              ('prod','130/70-13','Demanda A','novo',99,10)`,
    );
    const since = "((now() AT TIME ZONE 'America/Sao_Paulo')::date - 6)";
    const rows = await getBotMedidasMunicipio(db.pool, 'test', since);
    expect(rows.filter(r => r.municipio === 'Saquarema')).toEqual([
      { municipio:'Saquarema', medida:'130/70-13', consultas:2, galpao_qty:10 },
      { municipio:'Saquarema', medida:'180/55-17', consultas:1, galpao_qty:0 },
      { municipio:'Saquarema', medida:'195/55-16', consultas:1, galpao_qty:null },
    ]);
    expect(rows.filter(r => r.municipio === 'Cabo Frio')).toEqual([
      { municipio:'Cabo Frio', medida:'130/70-13', consultas:1, galpao_qty:10 },
    ]);
    expect((await getBotMedidasMunicipio(db.pool, 'prod', since)).find(r => r.municipio === 'Saquarema'))
      .toEqual({ municipio:'Saquarema', medida:'130/70-13', consultas:1, galpao_qty:99 });
    const panel = await getBotVisao('7d', 'test', db.pool);
    expect(panel.demanda_disponivel).toBe(true);
    expect(panel.medidas_por_municipio).toEqual(rows);
    await db.pool.query("UPDATE commerce.wholesale_stock SET quantity_on_hand=4 WHERE environment='test' AND measure='130/70-13' AND brand='Demanda A'");
    expect((await getBotMedidasMunicipio(db.pool, 'test', since)).find(r => r.municipio === 'Saquarema')?.galpao_qty).toBe(11);
  });

  it('mantém o mapa e sinaliza medidas indisponíveis quando a consulta falha', async () => {
    const query = db.pool.query.bind(db.pool);
    vi.spyOn(db.pool, 'query').mockImplementation(((sql: string, ...args: unknown[]) => {
      if (sql.includes('WITH procura AS')) return Promise.reject(new Error('indisponível'));
      return (query as (...a: unknown[]) => unknown)(sql, ...args);
    }) as typeof db.pool.query);
    const panel = await getBotVisao('7d', 'test', db.pool);
    expect(panel.demanda_disponivel).toBe(true);
    expect(panel.medidas_por_municipio).toBeNull();
    expect(panel.mapa.length).toBeGreaterThan(0);
  });
});

describe('fechamento real pelo Bot V2', () => {
  async function product() {
    const existing = await db.pool.query(
      `SELECT id FROM commerce.products WHERE environment='test' AND product_code='BOT-ORDER-TEST'`,
    );
    if (existing.rows[0]) return existing.rows[0].id as string;
    const id = (await db.pool.query(
      `INSERT INTO commerce.products(environment,product_code,product_name,product_type,brand,tire_condition)
       VALUES ('test','BOT-ORDER-TEST','Pneu teste pedido','tire','Pirelli','meia_vida') RETURNING id`,
    )).rows[0].id;
    await db.pool.query(`INSERT INTO commerce.tire_specs(environment,product_id,tire_size) VALUES ('test',$1,'90/90-12')`, [id]);
    await db.pool.query(
      `INSERT INTO commerce.product_prices(environment,product_id,price_amount,price_type)
       VALUES ('test',$1,89,'regular')`, [id],
    );
    await db.pool.query(
      `INSERT INTO commerce.matriz_product_prices(environment,product_id,price_amount)
       VALUES ('test',$1,89)`, [id],
    );
    return id as string;
  }

  async function order(c: Awaited<ReturnType<typeof conversation>>, id: string) {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const result = JSON.parse(await tools.executeTool(client, 'test', c.id, 'criar_pedido', {
        nome_cliente: 'Nome informado no fechamento', modalidade: 'pickup', forma_pagamento: 'pix',
        confirma_retirada_distante: true,
        itens: [{ product_id: id, quantidade: 1, preco_unitario: 89 }],
      }));
      expect(result.erro).toBeUndefined();
      expect(result.ok).toBe(true);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK'); throw e;
    } finally { client.release(); }
  }

  it('matriz: cria, consulta e repete sem duplicar pedido nem reserva', async () => {
    const c = await conversation();
    const p = await product();
    await db.pool.query(`INSERT INTO core.units(environment,slug,name) VALUES ('test','main','Matriz teste') ON CONFLICT DO NOTHING`);
    await db.pool.query(
      `INSERT INTO commerce.wholesale_stock(environment,measure,brand,tire_condition,quantity_on_hand,unit_cost)
       VALUES ('test','90/90-12','Pirelli','meia_vida',5,40)`,
    );
    const first = await order(c, p);
    expect((await order(c, p)).order_number).toBe(first.order_number);
    const rows = (await db.pool.query(
      `SELECT customer_name,partner_order_id FROM commerce.orders WHERE environment='test' AND source_conversation_id=$1`, [c.id],
    )).rows;
    expect(rows).toEqual([{ customer_name: 'Nome informado no fechamento', partner_order_id: null }]);
    const stock = (await db.pool.query(
      `SELECT quantity_on_hand,quantity_reserved FROM commerce.wholesale_stock
       WHERE environment='test' AND measure='90/90-12' AND brand='Pirelli'`,
    )).rows[0];
    expect(stock).toMatchObject({ quantity_on_hand: 5, quantity_reserved: 1 });
    const client = await db.pool.connect();
    try {
      const result = JSON.parse(await tools.executeTool(client, 'test', c.id, 'consultar_pedido', { order_number: first.order_number }));
      expect(result.encontrado).toBe(true);
      expect(JSON.stringify(result)).toContain('Nome informado no fechamento');
    } finally { client.release(); }
  });

  it('parceiro: cria pedido operacional e espelho, sem duplicar a reserva na repetição', async () => {
    const c = await conversation();
    const p = await product();
    const partner = await createPartnerFixture(db.pool, { initialStockQty: 5 });
    await db.pool.query(`UPDATE commerce.partner_stock_levels SET product_id=$1 WHERE id=$2`, [p, partner.stockId]);
    await pin(c);
    // Apenas a decisão geográfica é simulada. Pedido, espelho, estoque e consultas
    // usam o código real e todas as migrations, sem mocks de SQL nem chamadas externas.
    vi.spyOn(fulfillment, 'decideStoreForItemsGeo').mockResolvedValue({
      kind: 'partner', ringKm: 10, distanceKm: 2,
      routing: { unitId: partner.unitId, ctx: partner.ctx, items: [
        { product_id: p, partner_stock_id: partner.stockId, quantity: 1, central_price: 89 },
      ] },
    });
    const first = await order(c, p);
    expect((await order(c, p)).order_number).toBe(first.order_number);
    const mirrors = (await db.pool.query(
      `SELECT o.customer_name,o.unit_id,po.awaiting_pickup,po.total_amount
       FROM commerce.orders o JOIN commerce.partner_orders po ON po.id=o.partner_order_id
       WHERE o.environment='test' AND o.source_conversation_id=$1`, [c.id],
    )).rows;
    expect(mirrors).toEqual([{
      customer_name: 'Nome informado no fechamento', unit_id: partner.unitId,
      awaiting_pickup: true, total_amount: '89.00',
    }]);
    expect((await db.pool.query(
      `SELECT quantity_on_hand,quantity_reserved FROM commerce.partner_stock_levels WHERE id=$1`, [partner.stockId],
    )).rows[0]).toMatchObject({ quantity_on_hand: 5, quantity_reserved: 1 });
  });
});

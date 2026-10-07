import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { applyMigrationFile, startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';
import { botDemandLocationSql } from '../../src/admin/painel/bot-demand-location-sql.js';

const migration = '0227_demand_location_from_stock_search.sql';
const partialAddressMigration = '0236_demand_location_partial_address.sql';
let db: IntegrationDb;
let getBotVisao: typeof import('../../src/admin/painel/queries-bot-visao.js').getBotVisao;
let serial = 982700;

async function conversation(environment = 'test') {
  const cw = ++serial;
  const contact = (await db.pool.query(
    `INSERT INTO core.contacts(environment,chatwoot_contact_id,name)
     VALUES ($1,$2,'Teste localização') RETURNING id`, [environment,cw],
  )).rows[0].id;
  const id = (await db.pool.query(
    `INSERT INTO core.conversations(environment,chatwoot_conversation_id,chatwoot_account_id,
      contact_id,current_status,started_at,last_activity_at)
     VALUES ($1,$2,9827,$3,'open',now(),now()) RETURNING id`, [environment,cw,contact],
  )).rows[0].id;
  return { environment,cw,id };
}
type Conversation = Awaited<ReturnType<typeof conversation>>;

async function message(c: Conversation) {
  return (await db.pool.query(
    `INSERT INTO core.messages(environment,chatwoot_message_id,conversation_id,chatwoot_conversation_id,
      sender_type,message_type,content,is_private,sent_at)
     VALUES ($1,$2,$3,$4,'contact',0,'Bairro informado no teste',false,now()) RETURNING id`,
    [c.environment,++serial,c.id,c.cw],
  )).rows[0].id as string;
}

async function search(c: Conversation, msg: string, municipality: string | null) {
  await db.pool.query(
    `INSERT INTO ops.bot_stock_searches(environment,conversation_id,trigger_message_id,search_key,
      tool_name,measure,municipality,stores,occurred_at)
     VALUES ($1,$2,$3,$4,'buscar_produto','130/70-13',$5,'[]',now()-interval '10 seconds')`,
    [c.environment,c.id,msg,randomUUID(),municipality],
  );
}

async function lead(c: Conversation, msg: string, city?: string, bairro = 'Icaraí') {
  const actions = [{ role:'assistant',tool_calls:[
    { id:randomUUID(),type:'function',function:{ name:'registrar_localizacao_lead',arguments:JSON.stringify({
      texto_informado:`Sou de ${bairro}`,tipo:'regiao_digitada',bairro,municipio:city,
    }) } },
    { id:randomUUID(),type:'function',function:{ name:'buscar_produto',arguments:JSON.stringify({ medida_pneu:'130/70-13' }) } },
  ] }];
  await db.pool.query(
    `INSERT INTO agent.turns(environment,conversation_id,trigger_message_id,agent_version,context_hash,status,actions)
     VALUES ($1,$2,$3,'v2',$4,'delivered',$5::jsonb)`,
    [c.environment,c.id,msg,randomUUID(),JSON.stringify(actions)],
  );
}

async function partialAddress(c: Conversation, msg: string, street = 'Rua Dias da Cruz') {
  const actions = [{ role:'assistant',tool_calls:[
    { id:randomUUID(),type:'function',function:{ name:'registrar_localizacao_lead',arguments:JSON.stringify({
      texto_informado:street,tipo:'endereco_digitado',rua:street,
    }) } },
  ] }];
  await db.pool.query(
    `INSERT INTO agent.turns(environment,conversation_id,trigger_message_id,agent_version,context_hash,status,actions)
     VALUES ($1,$2,$3,'v2',$4,'delivered',$5::jsonb)`,
    [c.environment,c.id,msg,randomUUID(),JSON.stringify(actions)],
  );
}

async function partialNumber(c: Conversation, msg: string, number = '170') {
  const actions = [{ role:'assistant',tool_calls:[
    { id:randomUUID(),type:'function',function:{ name:'registrar_localizacao_lead',arguments:JSON.stringify({
      texto_informado:number,tipo:'endereco_digitado',numero:number,
    }) } },
  ] }];
  await db.pool.query(
    `INSERT INTO agent.turns(environment,conversation_id,trigger_message_id,agent_version,context_hash,status,actions)
     VALUES ($1,$2,$3,'v2',$4,'delivered',$5::jsonb)`,
    [c.environment,c.id,msg,randomUUID(),JSON.stringify(actions)],
  );
}

async function location(c: Conversation) {
  return (await db.pool.query(
    `SELECT municipio,source,truth_type FROM analytics.v_bot_demand_location
     WHERE environment=$1 AND conversation_id=$2`, [c.environment,c.id],
  )).rows[0];
}

async function panelLocation(c: Conversation) {
  return (await db.pool.query(
    `SELECT municipio FROM (${botDemandLocationSql}) locations WHERE conversation_id=$2`,
    [c.environment,c.id],
  )).rows[0]?.municipio;
}

async function history(c: Conversation) {
  const facts = (await db.pool.query(
    'SELECT * FROM analytics.conversation_facts WHERE environment=$1 AND conversation_id=$2 ORDER BY id',
    [c.environment,c.id],
  )).rows;
  const searches = (await db.pool.query(
    'SELECT * FROM ops.bot_stock_searches WHERE environment=$1 AND conversation_id=$2 ORDER BY id',
    [c.environment,c.id],
  )).rows;
  return { facts,searches };
}

beforeAll(async () => {
  db = await startPostgres({ throughMigration:'0226_catalog_measure_registrations.sql' });
  Object.assign(process.env,{
    NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:db.connectionString,
    CHATWOOT_HMAC_SECRET:'test-secret',ADMIN_AUTH_TOKEN:'test-admin-token',
  });
  ({ getBotVisao } = await import('../../src/admin/painel/queries-bot-visao.js'));
},180_000);
afterAll(async () => { if (db) await stopPostgres(db); });

describe('município já resolvido na busca do bot', () => {
  it('recupera Icaraí/Niterói no mapa e na medida, sem reescrever fatos ou triplicar a conversa', async () => {
    const c = await conversation(), msg = await message(c);
    await search(c,msg,'Niterói');
    await lead(c,msg);
    for (let i=0;i<2;i++) {
      const next = await message(c);
      await search(c,next,'Niterói');
      await lead(c,next);
    }
    const before = await history(c);
    expect(before.searches).toHaveLength(3);
    expect(before.facts.filter(f => f.fact_key==='localizacao_lead').every(f => !f.fact_value.municipio)).toBe(true);
    expect((await location(c)).municipio).toBeNull();
    expect((await getBotVisao('today','test',db.pool)).sem_regiao).toBe(1);

    await applyMigrationFile(db.pool,migration);
    await applyMigrationFile(db.pool,partialAddressMigration);
    expect(await location(c)).toEqual({ municipio:'Niterói',source:'stock_search_municipality',truth_type:'inferred' });
    const panel = await getBotVisao('today','test',db.pool);
    expect(panel.demanda_disponivel).toBe(true);
    expect(panel.sem_regiao).toBe(0);
    expect(panel.mapa).toEqual([{ municipio:'Niterói',chamou:1,pediu:0,efetivou:0,faltou:0 }]);
    expect(panel.medidas_por_municipio).toEqual([{ municipio:'Niterói',medida:'130/70-13',consultas:1,galpao_qty:null }]);
    await applyMigrationFile(db.pool,migration);
    await applyMigrationFile(db.pool,partialAddressMigration);
    expect(await history(c)).toEqual(before);
  });

  it('funciona para outros bairros sem sobrepor o município explicitamente registrado', async () => {
    const c = await conversation(), msg = await message(c);
    await search(c,msg,'Rio de Janeiro');
    await lead(c,msg,undefined,'Campo Grande');
    expect((await location(c)).municipio).toBe('Rio de Janeiro');
    const next = await message(c);
    await search(c,next,'Rio de Janeiro');
    await lead(c,next,'Maricá','Centro');
    expect((await location(c)).municipio).toBe('Maricá');
    expect(await panelLocation(c)).toBe('Maricá');
  });

  it('mantém a cidade resolvida quando uma rua posterior apenas completa o endereço', async () => {
    const c = await conversation(), regionMessage = await message(c);
    await search(c,regionMessage,'Rio de Janeiro');
    await lead(c,regionMessage,undefined,'Méier');
    await partialAddress(c,await message(c));
    await partialNumber(c,await message(c));
    expect(await location(c)).toEqual({
      municipio:'Rio de Janeiro',source:'stock_search_municipality',truth_type:'inferred',
    });
    const panel = await getBotVisao('today','test',db.pool);
    expect(panel.mapa.find(row => row.municipio==='Rio de Janeiro')).toMatchObject({ chamou:1 });
    expect(panel.sem_regiao).toBe(0);
  });

  it('não herda cidade antiga quando o cliente informa um bairro novo ainda desconhecido', async () => {
    const c = await conversation(), known = await message(c);
    await search(c,known,'Rio de Janeiro');
    await lead(c,known,undefined,'Méier');
    await lead(c,await message(c),undefined,'Bairro novo');
    await partialAddress(c,await message(c),'Rua sem cidade confirmada');
    expect((await location(c)).municipio).toBeNull();
    expect(await panelLocation(c)).toBeNull();
  });

  it('não associa busca de outra mensagem ou conversa a uma região nova ainda desconhecida', async () => {
    const c = await conversation(), old = await message(c);
    await search(c,old,'Niterói');
    await lead(c,old);
    await lead(c,await message(c),undefined,'Outro bairro');
    expect((await location(c)).municipio).toBeNull();
    expect(await panelLocation(c)).toBeNull();
    const other = await conversation();
    await lead(other,await message(other));
    expect((await location(other)).municipio).toBeNull();
    expect(await panelLocation(other)).toBeNull();
  });

  it('um pino mais recente sem geocodificação continua desconhecido até ser resolvido', async () => {
    const c = await conversation(), msg = await message(c);
    await search(c,msg,'Niterói');
    await lead(c,msg);
    const pinMsg = await message(c);
    await db.pool.query(
      `INSERT INTO core.message_attachments(environment,chatwoot_attachment_id,message_id,
        conversation_id,file_type,coordinates_lat,coordinates_lng)
       VALUES ($1,$2,$3,$4,'location',-22.2,-42.2)`, [c.environment,++serial,pinMsg,c.id],
    );
    expect((await location(c)).municipio).toBeNull();
    expect(await panelLocation(c)).toBeNull();
    await db.pool.query(
      `INSERT INTO commerce.geo_cache(cache_key,kind,value)
       VALUES ('r:-22.2000,-42.2000','reverse','{"municipio":"Itaboraí"}')`,
    );
    expect((await location(c)).municipio).toBe('Itaboraí');
  });

  it('não escolhe arbitrariamente quando a mesma mensagem gerou buscas em duas cidades', async () => {
    const c = await conversation(), msg = await message(c);
    await search(c,msg,'Niterói');
    await search(c,msg,'Maricá');
    await lead(c,msg);
    expect((await location(c)).municipio).toBeNull();
    expect(await panelLocation(c)).toBeNull();
  });

  it('não transforma busca sem cidade em localização e mantém produção separada dos testes', async () => {
    const c = await conversation(), msg = await message(c);
    await search(c,msg,null);
    await lead(c,msg);
    expect((await location(c)).municipio).toBeNull();
    const prod = await conversation('prod'), prodMsg = await message(prod); // Docker descartável.
    await search(prod,prodMsg,'Cidade isolada');
    await lead(prod,prodMsg);
    expect((await getBotVisao('today','test',db.pool)).mapa.some(r => r.municipio==='Cidade isolada')).toBe(false);
    expect((await getBotVisao('today','prod',db.pool)).mapa).toEqual([
      { municipio:'Cidade isolada',chamou:1,pediu:0,efetivou:0,faltou:0 },
    ]);
  });

  it('liga a busca posterior do 180/55-17 ao Méier sem editar fatos nem contar a conversa duas vezes', async () => {
    const c = await conversation();
    await lead(c,await message(c),undefined,'Méier');
    const lookup = await message(c);
    for (let i=0;i<2;i++) await db.pool.query(
      `INSERT INTO ops.bot_stock_searches(environment,conversation_id,trigger_message_id,search_key,
         tool_name,measure,municipality,stores,occurred_at)
       VALUES ($1,$2,$3,$4,'buscar_produto','180/55-17','Rio de Janeiro',
         '[{"id":"matriz","name":"Matriz","available":false}]',now())`,
      [c.environment,c.id,lookup,randomUUID()],
    );
    for (const [key,value] of [['medida_consultada','180/55-17'],
      ['faltou_estoque',{ medida:'180/55-17',motivo:'sem_estoque_perto' }]]) await db.pool.query(
      `INSERT INTO analytics.conversation_facts(environment,conversation_id,message_id,fact_key,
         fact_value,observed_at,truth_type,source,extractor_version)
       VALUES ($1,$2,$3,$4,$5::jsonb,now(),'observed','test',$6)`,
      [c.environment,c.id,lookup,key,JSON.stringify(value),randomUUID()],
    );
    expect((await location(c)).municipio).toBeNull();
    // Rua/número posteriores completam o bairro; não invalidam a busca entre as mensagens.
    await partialAddress(c,await message(c));
    await partialNumber(c,await message(c));
    expect((await location(c)).municipio).toBeNull();
    const before = await history(c);
    const panel = await getBotVisao('today','test',db.pool);
    expect(panel.demanda_disponivel).toBe(true);
    expect(panel.medidas_por_municipio?.find(row => row.municipio==='Rio de Janeiro' && row.medida==='180/55-17'))
      .toEqual({ municipio:'Rio de Janeiro',medida:'180/55-17',consultas:1,galpao_qty:null });
    expect(panel.mapa.find(row => row.municipio==='Rio de Janeiro')?.faltou).toBe(1);
    expect(await panelLocation(c)).toBe('Rio de Janeiro');
    await getBotVisao('today','test',db.pool);
    expect(await history(c)).toEqual(before);
  });
});

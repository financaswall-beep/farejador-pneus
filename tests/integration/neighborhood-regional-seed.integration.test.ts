import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AmbiguousNeighborhoodError, findNeighborhoodCandidates, resolveNeighborhoodCity } from '../../src/atendente-v2/neighborhood-resolution.js';
import { applyMigrationFile, startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

const seed = readFileSync('db/seeds/regiao-rio-de-janeiro.sql', 'utf8');
const regionalUpdate = seed.split('-- BEGIN GEO RJ 2026-09')[1]?.split('-- END GEO RJ 2026-09')[0];
const originalGeo = seed.split('\n').filter(line => line.startsWith('INSERT INTO "commerce"."geo_resolutions"')).join('\n');
let db: IntegrationDb;
let original: Array<Record<string, unknown>>;
let executeTool: typeof import('../../src/atendente-v2/tools.js').executeTool;
let prepareToolLocation: typeof import('../../src/atendente-v2/tool-location.js').prepareToolLocation;

async function snapshot(environment = 'prod') {
  return (await db.pool.query('SELECT * FROM commerce.geo_resolutions WHERE environment=$1 ORDER BY id', [environment])).rows;
}

async function resolve(input: string, city: string | null = null, environment = 'prod') {
  return (await db.pool.query(
    'SELECT * FROM commerce.resolve_neighborhood($1,$2,$3)', [environment, input, city],
  )).rows;
}

beforeAll(async () => {
  if (!regionalUpdate) throw Error('Carga regional ausente');
  db = await startPostgres({ throughMigration: '0227_demand_location_from_stock_search.sql' });
  await applyMigrationFile(db.pool, '0228_neighborhood_city_priority.sql');
  await db.pool.query(originalGeo);
  original = await snapshot();
  await db.pool.query(`INSERT INTO commerce.geo_resolutions
    (environment,neighborhood_name,neighborhood_canonical,city_name,state_code,aliases)
    VALUES ('test','Rio do Ouro','rio do ouro','Cidade de teste','RJ',ARRAY['teste isolado'])`);
  Object.assign(process.env, { NODE_ENV:'test', FAREJADOR_ENV:'test', DATABASE_URL:db.connectionString,
    CHATWOOT_HMAC_SECRET:'test-secret', ADMIN_AUTH_TOKEN:'test-admin-token', ROUTING_GEO:'false', LOCATION_FRESHNESS_HOURS:'24' });
  ({executeTool}=await import('../../src/atendente-v2/tools.js'));
  ({prepareToolLocation}=await import('../../src/atendente-v2/tool-location.js'));
}, 180_000);

afterAll(async () => { if (db) await stopPostgres(db); });

describe('atualização regional de bairros e preferência de município', () => {
  it('adiciona nomes documentados e aliases sem apagar dados antigos nem alterar test', async () => {
    expect(original).toHaveLength(624);
    const otherEnvironment = await snapshot('test');
    await db.pool.query(regionalUpdate!);
    const after = await snapshot();
    expect(after).toHaveLength(1038);
    const byId = new Map(after.map(row => [row.id, row]));
    for (const old of original) {
      const updated = byId.get(old.id);
      expect(updated).toBeDefined();
      for (const [column, value] of Object.entries(old)) {
        if (!['aliases', 'updated_at', 'city_resolution_priority'].includes(column)) expect(updated[column]).toEqual(value);
      }
      expect(updated.aliases).toEqual(expect.arrayContaining(old.aliases as string[]));
    }
    expect(await snapshot('test')).toEqual(otherEnvironment);
  });

  it('prefere Rio do Ouro/São Gonçalo, mantendo os outros municípios na consulta', async () => {
    const result = await resolve(' Rio do Ouro ');
    expect(result[0].city_name).toBe('São Gonçalo');
    expect(result.map(row => row.city_name)).toEqual(expect.arrayContaining(['São Gonçalo', 'Niterói', 'Magé', 'Rio Bonito']));
    expect(result.every(row => row.match_type === 'exact')).toBe(true);
    const priority = (await db.pool.query('SELECT city_name,neighborhood_canonical FROM commerce.geo_resolutions WHERE city_resolution_priority>0')).rows;
    expect(priority).toEqual([{city_name: 'São Gonçalo', neighborhood_canonical: 'rio do ouro'}]);
  });

  it('respeita o município explícito, inclusive sem acento, acima da preferência', async () => {
    for (const [input, expected] of [['Niteroi', 'Niterói'], ['Sao Goncalo', 'São Gonçalo'], ['Mage', 'Magé'], ['Rio Bonito', 'Rio Bonito']]) {
      const result = await resolve('RIO DO OURO', input);
      expect(result).toHaveLength(1);
      expect(result[0].city_name).toBe(expected);
    }
    expect(await resolve('Rio do Ouro', 'Município inexistente')).toEqual([]);
  });

  it('mantém Flamengo nas duas cidades e encontra os novos nomes de Niterói', async () => {
    expect((await resolve('Flamengo')).map(row => row.city_name)).toEqual(expect.arrayContaining(['Rio de Janeiro', 'Maricá']));
    for (const name of ['Centro', 'Maria Paula', 'Várzea das Moças']) {
      const result = await resolve(name, 'Niterói');
      expect(result[0]).toMatchObject({city_name: 'Niterói', match_type: 'exact'});
    }
    expect((await resolve('icarai'))[0]).toMatchObject({city_name: 'Niterói', match_type: 'exact'});
  });

  it('trata grafias alternativas como aliases e preserva subdivisões distintas', async () => {
    for (const [name, city] of [['Vital Brasil', 'Niterói'], ['Basílio', 'Rio Bonito'], ['XV de Novembro', 'Araruama']]) {
      expect((await resolve(name, city))[0]).toMatchObject({city_name: city, match_type: 'alias'});
    }
    for (const [name, city] of [['Tribobó II', 'São Gonçalo'], ['Tribobó III', 'São Gonçalo'], ['Apolo III', 'São Gonçalo'], ['Jardim Atlântico Oeste', 'Maricá']]) {
      expect((await resolve(name, city))[0]).toMatchObject({city_name: city, match_type: 'exact'});
    }
    expect((await resolve('Guia de Pacopaíba', 'Magé'))[0]).toMatchObject({neighborhood_canonical: 'guia de pacobaiba', match_type: 'alias'});
  });

  it('mantém fuzzy como fallback e isola os ambientes na resolução', async () => {
    expect((await resolve('Rio do Oruo'))[0]).toMatchObject({city_name: 'São Gonçalo', match_type: 'fuzzy'});
    expect((await resolve('Rio do Ouro', null, 'test')).map(row => row.city_name)).toEqual(['Cidade de teste']);
    expect(await resolve('Flamengo', null, 'test')).toEqual([]);
  });

  it('reaplica migration e carga sem duplicar ou alterar linhas já atualizadas', async () => {
    const before = await snapshot();
    await applyMigrationFile(db.pool, '0228_neighborhood_city_priority.sql');
    await db.pool.query(regionalUpdate!);
    expect(await snapshot()).toEqual(before);
  });
});

describe('bairro ambíguo antes das operações comerciais',()=>{
  it('retorna os municípios reais de Flamengo, sem escolher o primeiro nem gerar faltas',async()=>{
    const client=await db.pool.connect();
    try {
      await expect(resolveNeighborhoodCity(client,'prod','Flamengo')).rejects.toMatchObject({
        municipios:expect.arrayContaining(['Rio de Janeiro','Maricá']),
      });
      const beforeOrders=(await client.query('SELECT count(*) FROM commerce.orders')).rows;
      const beforeSearches=(await client.query('SELECT count(*) FROM ops.bot_stock_searches')).rows;
      for(const name of ['buscar_produto','buscar_compatibilidade','calcular_frete','localizacao_loja','pedir_foto','criar_pedido']) {
        const result=JSON.parse(await executeTool(client,'prod',randomUUID(),name,{bairro:'Flamengo',medida_pneu:'130/70-13'}));
        expect(result).toMatchObject({erro:'municipio_ambiguo',precisa_municipio:true,
          municipios_possiveis:expect.arrayContaining(['Rio de Janeiro','Maricá'])});
      }
      expect((await client.query('SELECT count(*) FROM commerce.orders')).rows).toEqual(beforeOrders);
      expect((await client.query('SELECT count(*) FROM ops.bot_stock_searches')).rows).toEqual(beforeSearches);
    }finally{client.release();}
  });

  it('respeita cidade explícita, bairro único, preferência regional e isolamento de ambiente',async()=>{
    const client=await db.pool.connect();
    try {
      await expect(resolveNeighborhoodCity(client,'prod','Flamengo','Marica')).resolves.toBe('Maricá');
      await expect(resolveNeighborhoodCity(client,'prod','Icarai')).resolves.toBe('Niterói');
      await expect(resolveNeighborhoodCity(client,'prod','Rio do Ouro')).resolves.toBe('São Gonçalo');
      await expect(resolveNeighborhoodCity(client,'prod','Rio do Ouro','Niteroi')).resolves.toBe('Niterói');
      await expect(resolveNeighborhoodCity(client,'test','Rio do Ouro')).resolves.toBe('Cidade de teste');
      await expect(resolveNeighborhoodCity(client,'prod','bairro totalmente inexistente xyz')).resolves.toBeNull();
    }finally{client.release();}
  });

  it('não esconde uma cidade em alias quando outra tem o mesmo nome exato',async()=>{
    const client=await db.pool.connect();
    try {
      await client.query(`INSERT INTO commerce.geo_resolutions(environment,neighborhood_name,neighborhood_canonical,city_name,state_code,aliases)
        VALUES ('test','Vila Teste','vila teste','Cidade A','RJ','{}'),
               ('test','Outro nome','outro nome','Cidade B','RJ',ARRAY['Vila Teste'])`);
      await expect(resolveNeighborhoodCity(client,'test','Vila Teste')).rejects.toMatchObject({municipios:['Cidade A','Cidade B']});
      await expect(resolveNeighborhoodCity(client,'test','Vila Teste','Cidade B')).resolves.toBe('Cidade B');
    }finally{client.release();}
  });

  it('não corta a lista fuzzy antes de detectar cidades diferentes',async()=>{
    const client=await db.pool.connect();
    try {
      for(let i=0;i<7;i++) await client.query(`INSERT INTO commerce.geo_resolutions
        (environment,neighborhood_name,neighborhood_canonical,city_name,state_code)
        VALUES ('test',$1,$1,$2,'RJ')`,[`bairro laboratorio ${i}`,i===6?'Cidade B':'Cidade A']);
      expect(await findNeighborhoodCandidates(client,'test','bairro laboratorio')).toHaveLength(7);
      await expect(resolveNeighborhoodCity(client,'test','bairro laboratorio')).rejects.toBeInstanceOf(AmbiguousNeighborhoodError);
    }finally{client.release();}
  });

  it('reutiliza município escrito na mensagem de origem sem reutilizar localização de outra conversa',async()=>{
    const client=await db.pool.connect();
    try {
      const contact=(await client.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name)
        VALUES ('prod',982899,'Teste cidade') RETURNING id`)).rows[0].id;
      const conv=(await client.query(`INSERT INTO core.conversations(environment,chatwoot_conversation_id,chatwoot_account_id,contact_id,current_status,started_at,last_activity_at)
        VALUES ('prod',982899,9828,$1,'open',now(),now()) RETURNING id`,[contact])).rows[0].id;
      const msg=(await client.query(`INSERT INTO core.messages(environment,chatwoot_message_id,conversation_id,chatwoot_conversation_id,sender_type,message_type,content,is_private,sent_at)
        VALUES ('prod',982899,$1,982899,'contact',0,'Flamengo, Maricá',false,now()) RETURNING id`,[conv])).rows[0].id;
      await client.query(`INSERT INTO analytics.conversation_facts(environment,conversation_id,message_id,observed_at,fact_key,fact_value,truth_type,source,confidence_level,extractor_version,ruleset_hash)
        VALUES ('prod',$1,$2,now(),'localizacao_lead',$3::jsonb,'inferred','llm_tool_call_v2',0.90,'city-confirmation-test','city-confirmation-test')`,
        [conv,msg,JSON.stringify({bairro:'Flamengo',municipio:'Maricá',texto_informado:'Flamengo, Maricá'})]);
      expect(await prepareToolLocation(client,'prod',conv,'buscar_produto',{bairro:'Flamengo',medida_pneu:'130/70-13'}))
        .toEqual({bairro:'Flamengo',municipio:'Maricá',medida_pneu:'130/70-13'});
      await expect(prepareToolLocation(client,'prod',randomUUID(),'buscar_produto',{bairro:'Flamengo'})).rejects.toBeInstanceOf(AmbiguousNeighborhoodError);
    }finally{client.release();}
  });
});

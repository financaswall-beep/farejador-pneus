import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildRestrictedConnectionString, startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

let db: IntegrationDb;
let tools: typeof import('../../src/atendente-v2/tools.js');
let consultations: typeof import('../../src/admin/dot/consultations.js');
let sampleProduct: string;

beforeAll(async () => {
  db = await startPostgres();
  Object.assign(process.env, { NODE_ENV:'test', FAREJADOR_ENV:'prod', DATABASE_URL:db.connectionString,
    PARTNER_DATABASE_URL:buildRestrictedConnectionString(db.connectionString), DATABASE_SSL:'false',
    CHATWOOT_HMAC_SECRET:'integration-secret', ADMIN_AUTH_TOKEN:'integration-token',
    ROUTING_GEO:'false', WHOLESALE_UNIFIED_STOCK:'false' });
  tools = await import('../../src/atendente-v2/tools.js');
  consultations = await import('../../src/admin/dot/consultations.js');
  // Reproduce o legado: somente o produto R18 tem vínculo, sem versão, nos dois eixos.
  sampleProduct = (await db.pool.query(`INSERT INTO commerce.products
    (environment,product_code,product_type,product_name,brand,tire_condition)
    VALUES ('prod','QA-HILUX','tire','QA 265/60-18','QA','novo') RETURNING id`)).rows[0].id;
  const spec = (await db.pool.query(`INSERT INTO commerce.tire_specs(environment,product_id,tire_size,vehicle_type)
    VALUES ('prod',$1,'265/60-18','car') RETURNING id`, [sampleProduct])).rows[0].id;
  const vehicle = (await db.pool.query(`INSERT INTO commerce.vehicle_models(environment,vehicle_type,make,model,year_start,year_end)
    VALUES ('prod','car','Toyota','Hilux',2016,2026) RETURNING id`)).rows[0].id;
  await db.pool.query(`INSERT INTO commerce.vehicle_fitments(environment,vehicle_model_id,tire_spec_id,position,source,year_start,year_end)
    VALUES ('prod',$1,$2,'both','manual',2016,2026)`, [vehicle,spec]);
}, 240000);

afterAll(async () => {
  if (tools) await Promise.all([(await import('../../src/persistence/db.js')).pool.end(),
    (await import('../../src/parceiro/db.js')).partnerPool.end()]);
  if (db) await stopPostgres(db);
});

it('identifica a medida usando as referências de fábrica, inclusive sem produto no catálogo', async () => {
  const client = await db.pool.connect();
  try {
    const lookup = async (modelo: string, aro?: number) => JSON.parse(await tools.executeTool(
      client, 'prod', randomUUID(), 'buscar_compatibilidade', { tipo_veiculo:'car', modelo, ano:2025, aro }));
    for (const [modelo, medida] of [['Hilux SR','265/65-17'],['Hilux SRX','265/60-18'],['Hilux Chassi','225/70-17']]) {
      const answer = await lookup(modelo!);
      expect(answer).toMatchObject({consultas_de_produto:[{medida_pneu:medida}], precisa_localizacao:true, estoque_consultado:false});
    }
    expect(await lookup('Hilux Cabine Dupla')).toMatchObject({precisa_confirmar_aro:true, consultas_de_produto:[]});
    expect(await lookup('Hilux Cabine Dupla',17)).toMatchObject({consultas_de_produto:[{medida_pneu:'265/65-17'}]});
    expect(await lookup('Hilux',17)).toMatchObject({precisa_confirmar_medida:true, consultas_de_produto:[]});
    expect(await lookup('Hilux')).toMatchObject({precisa_confirmar_medida:true, consultas_de_produto:[]});
  } finally { client.release(); }
});

it('confirma o pneu individual apenas quando o vínculo está na versão e nos eixos consultados', async () => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const lookup = async (modelo:string) => JSON.parse(await tools.executeTool(client,'prod',randomUUID(),
      'buscar_compatibilidade',{tipo_veiculo:'car',modelo,ano:2025,produto_id:sampleProduct}));
    expect(await lookup('Hilux SRX')).toMatchObject({produto_confirmado:false});
    await client.query(`INSERT INTO commerce.vehicle_fitments(environment,vehicle_model_id,tire_spec_id,position,source,year_start,year_end)
      SELECT v.environment,v.id,s.id,'both','manual',2025,2025 FROM commerce.vehicle_models v
      JOIN commerce.tire_specs s ON s.environment=v.environment AND s.product_id=$1
      WHERE v.environment='prod' AND v.make='Toyota' AND v.model='Hilux' AND v.variant='SRX'`,[sampleProduct]);
    expect(await lookup('Hilux SRX')).toMatchObject({produto_confirmado:true});
    expect(await lookup('Hilux SR')).toMatchObject({produto_confirmado:false});
  } finally { await client.query('ROLLBACK'); client.release(); }
});

it('normaliza a medida informada à Milly nas duas visões sem perder a busca parcial', async () => {
  for (const visao of ['produtos','compatibilidade']) {
    const lookup = (medida:string) => consultations.runDotConsultation('consultar_catalogo_matriz',{visao,medida});
    const canonical = await lookup('265/60-18');
    expect(canonical.rows.length).toBeGreaterThan(0);
    for (const size of ['265/60 R18','265/60r18','265/60']) expect((await lookup(size)).rows).toEqual(canonical.rows);
  }
  const seeded = await db.pool.query(`SELECT count(*)::int total, count(DISTINCT reference->>'vehicle_model_id')::int versions
    FROM commerce.vehicle_measure_applications WHERE environment='prod' AND import_batch='toyota-br-hilux-my25'
    AND year_start=2025 AND year_end=2025 AND status='verified' AND reference->>'product_fitment_confirmed'='false'`);
  expect(seeded.rows[0]).toEqual({total:20,versions:10});
});

import { randomUUID } from 'node:crypto';
import Fastify, {type FastifyInstance} from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildRestrictedConnectionString, startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';
import { createPartnerFixture } from './helpers/partner-fixtures.js';

let db: IntegrationDb, app: FastifyInstance;
const headers = {authorization: 'Bearer catalog-test', 'x-operator-label': 'Revisora do catálogo'};
const model = {vehicle_type:'car', make:'Marca Sintética', model:'Modelo A', variant:'Versão X',
  year_start:2021, year_end:2024};
const size = '265/60-18';
const postModel = (payload: object) => app.inject({method:'POST', url:'/admin/api/catalog/vehicle-models', headers, payload});
const postRef = (product: string, payload: object) =>
  app.inject({method:'POST', url:`/admin/api/catalog/${product}/measure-applications`, headers, payload});
const productUrl = (id: string) => `/admin/api/catalog/${id}/compatibility`;

async function tire(vehicleType: string | null, environment = 'test') {
  const id = randomUUID();
  await db.pool.query(`INSERT INTO commerce.products(id,environment,product_code,product_type,product_name,brand,tire_condition)
    VALUES ($1,$2,$3,'tire',$3,$3,'novo')`, [id, environment, 'fixture-'+id]);
  await db.pool.query(`INSERT INTO commerce.tire_specs(environment,product_id,tire_size,vehicle_type)
    VALUES ($1,$2,$3,$4)`, [environment, id, size, vehicleType]);
  return id;
}

beforeAll(async () => {
  db = await startPostgres();
  Object.assign(process.env, {NODE_ENV:'test', FAREJADOR_ENV:'test', DATABASE_URL:db.connectionString,
    PARTNER_DATABASE_URL:buildRestrictedConnectionString(db.connectionString), DATABASE_SSL:'false',
    CHATWOOT_HMAC_SECRET:'test', ADMIN_BEARER_FALLBACK_ENABLED:'true', ADMIN_AUTH_TOKEN:'catalog-test'});
  const { registerPainelCatalogo } = await import('../../src/admin/painel/route-catalogo.js');
  app = Fastify();
  await registerPainelCatalogo(app);
}, 240000);

afterAll(async () => {
  if (app) await app.close();
  if (db) {
    const {pool} = await import('../../src/persistence/db.js');
    const {partnerPool} = await import('../../src/parceiro/db.js');
    await Promise.all([pool.end(), partnerPool.end()]);
    await stopPostgres(db);
  }
});

it('valida e serializa o cadastro de modelos, inclusive sem versão', async () => {
  const request = {method:'POST' as const, url:'/admin/api/catalog/vehicle-models', payload:model};
  expect((await app.inject(request)).statusCode).toBe(401);
  for (const payload of [{...model,vehicle_type:'motorcycle'}, {...model,year_end:2010}, {...model,environment:'prod'}])
    expect((await postModel(payload)).json()).toEqual({error:'invalid_car_model'});
  const results = await Promise.all([postModel({...model,variant:null}), postModel({...model,model:'modelo   a',variant:null})]);
  expect(results.map(r => r.statusCode).sort()).toEqual([200,201]);
  expect(results[0].json().vehicle.vehicle_model_id).toBe(results[1].json().vehicle.vehicle_model_id);
  expect((await postModel({...model,variant:null,year_end:2025})).statusCode).toBe(409);
  const overlapping = await Promise.all([
    postModel({...model,variant:'Sobreposição',year_start:2021,year_end:2025}),
    postModel({...model,variant:'sobreposição',year_start:2025,year_end:2026})
  ]);
  expect(overlapping.map(r=>r.statusCode).sort()).toEqual([201,409]);
});

it('exige o papel de proprietário mesmo quando o colaborador tem acesso ao catálogo', async () => {
  const person = (await db.pool.query(`INSERT INTO network.partner_people(environment,username)
    VALUES ('test','catalogo-car-fixture') RETURNING id`)).rows[0].id;
  const staff = (await db.pool.query(`INSERT INTO network.matriz_collaborators
    (environment,person_id,display_name,job,panel_role,job_title,work_area)
    VALUES ('test',$1,'Catalogador','vendedor','admin','Catalogador','sales') RETURNING id`, [person])).rows[0].id;
  await db.pool.query(`INSERT INTO network.matriz_collaborator_operation_permissions
    (collaborator_id,environment,allow_vendas,allow_entregas,allow_financeiro,allow_catalogo)
    VALUES ($1,'test',false,false,false,true)`, [staff]);
  const {mintMatrizAdminSessionForPerson,ADMIN_SESSION_COOKIE} = await import('../../src/admin/session.js');
  const session = await mintMatrizAdminSessionForPerson('test',person,staff,db.pool);
  const sessionHeaders = {cookie:`${ADMIN_SESSION_COOKIE}=${session!.sessionToken}`, 'sec-fetch-site':'same-origin'};
  for (const url of ['/admin/api/catalog/vehicle-models', `/admin/api/catalog/${randomUUID()}/measure-applications`]) {
    const denied = await app.inject({method:'POST',url,headers:sessionHeaders,payload:model});
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({error:'admin_owner_required'});
  }
});

it('cadastra fonte por versão, anos e eixo, com repetição concorrente e rollback integral', async () => {
  const car = await tire('car'), other = await tire('car'), motorcycle = await tire('motorcycle'), unknown = await tire(null);
  const vehicle = (await postModel(model)).json().vehicle;
  const ref = {vehicle_model_id:vehicle.vehicle_model_id, tire_size:'265/60 R18', position:'both', index_spec:'110T',
    year_start:2022, year_end:2022, source_url:'https://example.org/manual-2022'};
  expect((await app.inject({method:'POST', url:`/admin/api/catalog/${car}/measure-applications`,payload:ref})).statusCode).toBe(401);
  const repeated = await Promise.all([postRef(car, ref), postRef(other, ref)]);
  expect(repeated.map(r => r.statusCode).sort()).toEqual([200,201]);
  expect(repeated.map(r => r.json().created).sort()).toEqual([0,2]);

  expect((await postRef(motorcycle,ref)).json()).toEqual({error:'catalog_car_required'});
  expect((await postRef(unknown,ref)).json()).toEqual({error:'catalog_car_required'});
  expect((await postRef(await tire('car','prod'),ref)).json()).toEqual({error:'catalog_product_not_found'});
  for (const [environment, type] of [['prod','car'],['test','motorcycle']]) {
    const target = await db.pool.query(`INSERT INTO commerce.vehicle_models(environment,vehicle_type,make,model)
      VALUES ($1,$2,$3,$4) RETURNING id`, [environment,type,model.make,model.model]);
    expect((await postRef(car,{...ref,vehicle_model_id:target.rows[0].id})).json()).toEqual({error:'catalog_vehicle_model_not_found'});
  }
  expect((await postRef(car,{...ref,tire_size:'205/55R16'})).json()).toEqual({error:'catalog_application_measure_mismatch'});
  expect((await postRef(car,{...ref,year_end:2025})).json()).toEqual({error:'catalog_application_years_mismatch'});
  expect((await postRef(car,{...ref,source_url:'http://example.org'})).statusCode).toBe(400);
  expect((await postRef(car,{...ref,source_url:'https://conta:chave@example.org'})).statusCode).toBe(400);
  const onlyRear = {...ref, year_start:2023, year_end:2023, position:'rear'};
  expect((await postRef(car,onlyRear)).statusCode).toBe(201);
  expect((await postRef(car,{...onlyRear,position:'both',index_spec:'112T'})).json()).toEqual({error:'catalog_application_conflict'});

  const fichas = await Promise.all([car,other,motorcycle,unknown].map(async id => (await app.inject({url:productUrl(id),headers})).json()));
  expect(fichas.map(f => f.applications.length)).toEqual([3,3,0,0]);
  const draft = await app.inject({url:'/admin/api/catalog/measure-applications',
    query:{measure:size, vehicle_type:'unknown'},headers});
  expect(draft.statusCode).toBe(200);
  expect(draft.json().applications).toEqual([]);
  expect(fichas[0].rows).toEqual([]);
  expect(fichas[0].applications.filter((a: {year_start: number}) => a.year_start===2022)).toHaveLength(2);
  expect(fichas[0].applications[0]).toMatchObject({vehicle_type:'car', reference_model:'Modelo A Versão X', vehicle_variant:'Versão X',
    source_url:ref.source_url, range_source_urls:[ref.source_url], validation_scope:'manufacturer_measure',
    display_measure:size, tire_size:'265/60R18', product_fitment_confirmed:false, vehicle_model_id:vehicle.vehicle_model_id});
  const history = await db.pool.query(`SELECT event_type FROM audit.events WHERE environment='test' AND entity_id=$1 AND actor_label=$2`,
    [vehicle.vehicle_model_id,headers['x-operator-label']]);
  expect(history.rows.map(r => r.event_type).sort()).toEqual([
    'catalog_car_measure_application_created','catalog_car_measure_application_created',
    'catalog_car_measure_application_created','catalog_car_model_created']);

  // As duas rotas do parceiro enxergam as novas referências pela role com RLS.
  await db.pool.query(`INSERT INTO commerce.vehicle_measure_applications
    (environment,application_id,make,model,position,tire_size,display_measure,status,application_kind,reference,import_batch)
    VALUES ('test','fixture-legado','Marca','Moto legada','rear',$1,$1,'verified','original',
      '{"source_url":"https://example.org/legado"}','fixture')`, [size]);
  const {getPartnerPanelCatalog, getPartnerPanelCatalogCompatibility} = await import('../../src/parceiro/panel-catalog.js');
  const {ctx} = await createPartnerFixture(db.pool);
  const list = await getPartnerPanelCatalog(ctx);
  for (const [id,count] of [[car,3],[motorcycle,1],[unknown,1]] as const) {
    expect(list.rows.find(r => r.product_id===id)?.application_count).toBe(count);
    const detail = await getPartnerPanelCatalogCompatibility(ctx, id);
    expect(detail.applications).toHaveLength(count);
    if (id!==car) expect(detail.applications[0]?.application_id).toBe('fixture-legado');
  }
});

it('salva sem link e reconhece repetições omitidas, nulas, vazias ou em branco', async () => {
  const car = await tire('car');
  const {vehicle} = (await postModel({...model, variant:'Sem link'})).json();
  const ref = {vehicle_model_id:vehicle.vehicle_model_id, tire_size:'265/60R18', position:'rear',
    year_start:2021, year_end:2024};
  const results = await Promise.all([{}, {source_url:null}, {source_url:''}, {source_url:'  '}]
    .map(source => postRef(car, {...ref,...source})));
  expect(results.map(r => r.statusCode).sort()).toEqual([200,200,200,201]);
  expect(results.map(r => r.json().created).sort()).toEqual([0,0,0,1]);
  const ficha = (await app.inject({url:productUrl(car),headers})).json();
  const saved = ficha.applications.filter((a: {vehicle_model_id: string}) => a.vehicle_model_id === ref.vehicle_model_id);
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({source_url:null, range_source_urls:[], source_checked_at:null,
    source_type:'Cadastro manual da Matriz', validation_scope:'catalog_measure', product_fitment_confirmed:false,
    position:'rear', year_start:2021, year_end:2024, tire_size:'265/60R18'});
});

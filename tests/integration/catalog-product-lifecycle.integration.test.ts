import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';
import type { DotIdentity } from '../../src/admin/dot/token-store.js';

let db: IntegrationDb, identity: DotIdentity;
let registry: typeof import('../../src/admin/dot/inventory-registry.js').inventoryRegistry;
const status = 'alterar_status_produto_catalogo', edit = 'corrigir_identidade_produto_catalogo';
function call(tool: string, args: object) {
  return registry.get(tool)!.run(identity,args) as Promise<Record<string,any>>;
}
async function authorize(row: Record<string,any>) {
  expect(row).toMatchObject({status:'aguardando_autorizacao',executada:false,confirmacao:'conversa'});
  const { ownerReview } = await import('../../src/admin/dot/operation-reviews.js');
  await ownerReview(identity.person_id,row.proposta,'autorizada',{grantId:identity.grant_id,fingerprint:row.fingerprint});
}
async function seed() {
  const id=randomUUID(), code='F-'+id.toUpperCase();
  await db.pool.query(`INSERT INTO commerce.products (id,environment,product_code,product_name,product_type,brand,tire_condition)
    VALUES ($1,'test',$2,$2,'tire',$2,'novo')`,[id,code]);
  await db.pool.query(`INSERT INTO commerce.tire_specs(environment,product_id,tire_size,vehicle_type)
    VALUES ('test',$1,'265/60-18','car')`,[id]);
  return {id,code};
}
beforeAll(async()=>{
  Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_SSL:'false',CHATWOOT_HMAC_SECRET:'fixture',
    ADMIN_AUTH_TOKEN:'fixture',DOT_MCP_ENABLED:'true',DOT_MCP_PUBLIC_ORIGIN:'https://example.org'});
  db=await startPostgres();
  process.env.DATABASE_URL=db.connectionString;
  const p=(await db.pool.query(`INSERT INTO network.partner_people(environment,username,password_hash)
    VALUES('test','dono-ficha','fixture') RETURNING id`)).rows[0]!.id;
  const c=(await db.pool.query(`INSERT INTO network.matriz_collaborators(environment,person_id,display_name,job,panel_role,job_title,work_area)
    VALUES('test',$1,'Dono','colaborador','owner','Dono','administrative') RETURNING id`,[p])).rows[0]!.id;
  const g=(await db.pool.query(`INSERT INTO network.dot_oauth_grants(environment,person_id,collaborator_id,client_id,resource,scope,
    code_hash,code_challenge,redirect_uri,operation_confirmation,catalog_operations_enabled,code_used_at)
    VALUES('test',$1,$2,'farejador-dot','https://example.org/admin/dot/mcp','farejador.read',repeat('a',64),repeat('b',43),
    'https://example.org/callback','conversa',true,now()) RETURNING id`,[p,c])).rows[0]!.id;
  identity={grant_id:g,person_id:p,collaborator_id:c};
  registry=(await import('../../src/admin/dot/inventory-registry.js')).inventoryRegistry;
  await import('../../src/admin/dot/inventory-product-lifecycle-tools.js');
},240_000);
afterAll(async()=>{
  if (registry) await (await import('../../src/persistence/db.js')).pool.end();
  if (db) await stopPostgres(db);
});

it('exibe o impacto, exige autorização, substitui com outro ID e preserva o original e seus preços',async()=>{
  const {id,code}=await seed();
  await db.pool.query("INSERT INTO commerce.matriz_product_prices(environment,product_id,price_amount) VALUES ('test',$1,250)",[id]);
  const args={product_id:id,tire_condition:'remold',product_code:code+'-R',reason:'corrigir condição',idempotency_key:randomUUID()};
  const proposal=await call(edit,args);
  expect(proposal.dados.efeitos).toMatchObject({operacao:'substituir',bloqueios:[],impacto:{ficha:{precos_varejo:1}}});
  await authorize(proposal);
  const result=await call(edit,args);
  expect(result.resultado).toMatchObject({changed:true,produto_arquivado:id,produto:{product_code:code+'-R',tire_condition:'remold',archived:false}});
  expect(result.resultado.produto.product_id).not.toBe(id);
  expect(await call(edit,args)).toEqual(result);
  expect(await call('consultar_impacto_produto_catalogo',{product_id:id})).toMatchObject({produto:{archived:true,tire_condition:'novo'},impacto:{ficha:{precos_varejo:1}}});
  expect(await call('consultar_impacto_produto_catalogo',{product_id:result.resultado.produto.product_id})).toMatchObject({impacto:{ficha:{precos_varejo:0,vinculos:0}}});
  expect(await call('buscar_produtos_arquivados_catalogo',{q:code})).toEqual(expect.arrayContaining([expect.objectContaining({product_id:id})]));
});
it('revalida um saldo que surgiu depois da proposta, inclusive no galpão por medida e marca',async()=>{
  const {id,code}=await seed();
  const args={product_id:id,acao:'arquivar',reason:'revisão',idempotency_key:randomUUID()};
  await authorize(await call(status,args));
  await db.pool.query("INSERT INTO commerce.wholesale_stock(environment,measure,brand,tire_condition,quantity_on_hand) VALUES ('test','265/60-18',$1,'novo',2)",[code]);
  await expect(call(status,args)).rejects.toThrow('dados_da_proposta_mudaram');
  expect(await call('consultar_impacto_produto_catalogo',{product_id:id})).toMatchObject({produto:{archived:false},impedimentos_arquivamento:['saldo']});
});
it('reserva o código antigo para o SKU arquivado mesmo na correção exclusiva do código',async()=>{
  const {id,code}=await seed();
  await db.pool.query("UPDATE commerce.tire_specs SET construction='radial',load_index='110' WHERE environment='test' AND product_id=$1",[id]);
  const args={product_id:id,product_code:code+'-N',reason:'corrigir código impresso',idempotency_key:randomUUID()};
  await authorize(await call(edit,args));
  const {produto}= (await call(edit,args)).resultado;
  expect(produto.product_id).not.toBe(id);
  expect(produto.tire_size).toBe('265/60-18');
  expect((await db.pool.query("SELECT construction,load_index FROM commerce.tire_specs WHERE environment='test' AND product_id=$1",
    [produto.product_id])).rows).toEqual([{construction:'radial',load_index:'110'}]);
  const historical=await db.pool.query(`SELECT id,deleted_at IS NOT NULL archived
    FROM commerce.products WHERE environment='test' AND product_code=$1`,[code]);
  expect(historical.rows).toEqual([{id,archived:true}]);
  expect((await db.pool.query(`SELECT id FROM commerce.products WHERE environment='test'
    AND product_code=$1 AND deleted_at IS NULL`,[code])).rowCount).toBe(0);
  await expect(db.pool.query(`INSERT INTO commerce.products(environment,product_code,product_name,product_type,brand,tire_condition)
    VALUES ('test',$1,'Outro pneu','tire','Outra','novo')`,[code])).rejects.toMatchObject({code:'23505'});
});
it('impede reativar uma variante substituída por outra ficha ativa da mesma identidade',async()=>{
  const {id,code}=await seed();
  const archive={product_id:id,acao:'arquivar',reason:'revisão',idempotency_key:randomUUID()};
  await authorize(await call(status,archive));
  await call(status,archive);
  const other=randomUUID();
  await db.pool.query(`INSERT INTO commerce.products(id,environment,product_code,product_name,product_type,brand,tire_condition)
    VALUES ($1,'test',$2,$2,'tire',$3,'novo')`,[other,code+'-2',code]);
  await db.pool.query("INSERT INTO commerce.tire_specs(environment,product_id,tire_size) VALUES ('test',$1,'265/60R18')",[other]);
  const restore={...archive,acao:'reativar',idempotency_key:randomUUID()};
  const proposal=await call(status,restore);
  expect(proposal.dados.efeitos.bloqueios).toEqual(['ja_existe_ficha_ativa_para_a_variante']);
  await authorize(proposal);
  await expect(call(status,restore)).rejects.toThrow('ja_existe_ficha_ativa_para_a_variante');
});
it('arquiva e reativa o mesmo ID, corrige texto separadamente e exige permissão de catálogo',async()=>{
  const {id}=await seed();
  for(const acao of ['arquivar','reativar']){
    const args={product_id:id,acao,reason:'revisão',idempotency_key:randomUUID()};
    await authorize(await call(status,args));
    expect((await call(status,args)).resultado.produto).toMatchObject({product_id:id,archived:acao==='arquivar'});
  }
  const args={product_id:id,product_name:'Nome conferido',reason:'correção de digitação',idempotency_key:randomUUID()};
  await authorize(await call(edit,args));
  expect((await call(edit,args)).resultado.produto).toMatchObject({product_name:'Nome conferido',product_id:id});
  await db.pool.query("UPDATE network.dot_oauth_grants SET catalog_operations_enabled=false WHERE id=$1",[identity.grant_id]);
  await expect(call(edit,{...args,idempotency_key:randomUUID()})).rejects.toThrow('dot_catalog_disabled');
});

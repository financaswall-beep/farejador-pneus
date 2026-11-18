import {randomBytes,randomUUID} from 'node:crypto';
import {beforeAll,beforeEach,afterAll,it,expect,vi} from 'vitest';
import {startPostgres,stopPostgres,type IntegrationDb} from './helpers/postgres.js';
import type {DotIdentity} from '../../src/admin/dot/token-store.js';
let db:IntegrationDb,identity:DotIdentity;
let invoke:typeof import('../../src/admin/dot/mcp-server.js').invokeDotTool;
let productId:string,brand:string;
const measure='205/55 R16';
beforeAll(async()=>{
  Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgres://test',DATABASE_SSL:'false',
    CHATWOOT_HMAC_SECRET:'test-secret',ADMIN_AUTH_TOKEN:'test-emergency',DOT_MCP_ENABLED:'true',
    DOT_MCP_PUBLIC_ORIGIN:'https://farejador.example',DOT_MCP_REDIRECT_URIS:'https://chatgpt.com/connector_platform_oauth_redirect',
    MATRIZ_CENTRAL_LEDGER:'true',MATRIZ_CENTRAL_LEDGER_READ:'true',MATRIZ_EXPENSES:'true',WHOLESALE_FINANCE:'true',
    WHOLESALE_STOCK_DECREMENT:'true',MARKETING_PUBLISHER_ENABLED:'true'});
  db=await startPostgres();process.env.DATABASE_URL=db.connectionString;vi.resetModules();
  invoke=(await import('../../src/admin/dot/mcp-server.js')).invokeDotTool;
},240000);
async function grant(person?:string,collaborator?:string){
  person??=(await db.pool.query(`INSERT INTO network.partner_people(environment,username,password_hash) VALUES('test',$1,'hash-fixture') RETURNING id`,['milly-'+randomUUID()])).rows[0].id;
  collaborator??=(await db.pool.query(`INSERT INTO network.matriz_collaborators(environment,person_id,display_name,job,panel_role,job_title,work_area)
    VALUES('test',$1,'Dono de teste','colaborador','owner','Dono','administrative') RETURNING id`,[person])).rows[0].id;
  const id=(await db.pool.query(`INSERT INTO network.dot_oauth_grants(environment,person_id,collaborator_id,client_id,resource,scope,code_hash,
    code_challenge,redirect_uri,code_used_at,operation_confirmation,stock_operations_enabled,catalog_operations_enabled,finance_operations_enabled,publisher_enabled,installment_reviews_enabled)
    VALUES('test',$1,$2,'farejador-dot','https://farejador.example/admin/dot/mcp','farejador.read',$3,$4,
      'https://chatgpt.com/connector_platform_oauth_redirect',now(),'conversa',true,true,true,true,true) RETURNING id`,
  [person,collaborator,randomBytes(32).toString('hex'),'a'.repeat(43)])).rows[0].id;
  return {person_id:person!,collaborator_id:collaborator!,grant_id:id,installment_reviews_enabled:true,installment_chat_confirmation:true};
}
async function call(name:string,args:object,who=identity):Promise<any>{
  const response=await invoke(who,name,args);
  if('isError' in response&&response.isError)return {isError:true,text:response.content};
  return 'structuredContent' in response?response.structuredContent:response;
}
async function approve(name:string,data:object){
  const pending=await call(name,data);
  expect(pending).toMatchObject({status:'aguardando_autorizacao',executada:false,confirmacao:'conversa'});
  expect(pending.confirm_url).toBeUndefined();
  const confirmed=await call('confirmar_operacao_milly',{proposta:pending.proposta,fingerprint:pending.fingerprint,autorizado_pelo_dono:true});
  expect(confirmed).toMatchObject({status:'autorizada',executada:false});
  return call(name,data);
}
beforeEach(async()=>{
  identity=await grant();brand='Teste '+randomUUID().slice(0,8);
  const product=await approve('cadastrar_produto_catalogo',{creation_mode:'manual',measure,brand,tire_condition:'novo',
    product_code:'TEST-'+randomUUID(),product_name:'Pneu de teste',vehicle_type:'car',idempotency_key:randomUUID()});
  expect(product.executada).toBe(true);productId=product.resultado.product_id;
});
afterAll(async()=>{
  if(db){await (await import('../../src/persistence/db.js')).pool.end();await stopPostgres(db);}
});

it('aprovação fica ligada aos dados e à conexão; grava preço uma vez mesmo com chamadas concorrentes',async()=>{
  const data={product_id:productId,price_amount:295.50,reason:'Preço informado pelo dono',idempotency_key:randomUUID()};
  const pending=await call('alterar_preco_catalogo',data);
  expect((await db.pool.query('SELECT 1 FROM commerce.matriz_product_prices WHERE product_id=$1',[productId])).rowCount).toBe(0);
  const other=await grant(identity.person_id,identity.collaborator_id);
  expect((await call('confirmar_operacao_milly',{proposta:pending.proposta,fingerprint:pending.fingerprint,autorizado_pelo_dono:true},other)).isError).toBe(true);
  expect((await call('confirmar_operacao_milly',{proposta:pending.proposta,fingerprint:'0'.repeat(64),autorizado_pelo_dono:true})).isError).toBe(true);
  expect((await call('alterar_preco_catalogo',{...data,price_amount:1})).isError).toBe(true);
  await call('confirmar_operacao_milly',{proposta:pending.proposta,fingerprint:pending.fingerprint,autorizado_pelo_dono:true});
  const results=await Promise.all([call('alterar_preco_catalogo',data),call('alterar_preco_catalogo',data)]);
  expect(results[0]).toEqual(results[1]);expect(results[0].executada).toBe(true);
  expect((await db.pool.query('SELECT count(*)::int n FROM commerce.matriz_product_prices WHERE product_id=$1',[productId])).rows[0].n).toBe(1);
  expect((await call('consultar_proposta_milly',{proposta:pending.proposta})).status).toBe('executada');
});
it('recusa e expiração não viram uma nova autorização silenciosa',async()=>{
  const data={product_id:productId,price_amount:200,reason:'Preço recusado',idempotency_key:randomUUID()};
  const pending=await call('alterar_preco_catalogo',data);
  await call('recusar_operacao_milly',{proposta:pending.proposta});
  expect((await call('alterar_preco_catalogo',data)).status).toBe('recusada');
  const next={...data,idempotency_key:randomUUID()};const expired=await call('alterar_preco_catalogo',next);
  await db.pool.query("UPDATE network.dot_operation_reviews SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.proposta]);
  expect((await call('confirmar_operacao_milly',{proposta:expired.proposta,fingerprint:expired.fingerprint,autorizado_pelo_dono:true})).isError).toBe(true);
  expect((await call('alterar_preco_catalogo',next)).status).toBe('expirada');
});
it('entrada e perda preservam quantidade, custo e repetição; reserva bloqueia perda excessiva',async()=>{
  const entry={measure,brand,tire_condition:'novo',quantity_in:4,unit_cost:70,entry_nature:'opening_balance',reason:'Saldo conferido',idempotency_key:randomUUID()};
  const result=await approve('registrar_entrada_estoque',entry);expect(result.executada).toBe(true);
  expect(await call('registrar_entrada_estoque',entry)).toEqual(result);
  const stock=(await db.pool.query("SELECT id,quantity_on_hand FROM commerce.wholesale_stock WHERE environment='test' AND brand=$1",[brand])).rows[0];
  expect(stock.quantity_on_hand).toBe(4);
  await db.pool.query('UPDATE commerce.wholesale_stock SET quantity_reserved=3 WHERE id=$1',[stock.id]);
  const loss={measure:result.resultado.measure,brand,tire_condition:'novo',quantity:2,nature:'loss',reason:'Perda informada',idempotency_key:randomUUID()};
  expect((await approve('registrar_perda_estoque',loss)).isError).toBe(true);
  expect((await db.pool.query('SELECT quantity_on_hand FROM commerce.wholesale_stock WHERE id=$1',[stock.id])).rows[0].quantity_on_hand).toBe(4);
  expect((await db.pool.query("SELECT 1 FROM audit.operation_idempotency WHERE domain='dot.registrar_perda_estoque' AND idempotency_key=$1",[loss.idempotency_key])).rowCount).toBe(0);
  const valid={...loss,quantity:1,idempotency_key:randomUUID()};expect(await approve('registrar_perda_estoque',valid)).toMatchObject({executada:true});
  expect((await db.pool.query('SELECT quantity_on_hand FROM commerce.wholesale_stock WHERE id=$1',[stock.id])).rows[0].quantity_on_hand).toBe(3);
});
it('financeiro com monitor ativo confirma na conversa e revogação impede execução',async()=>{
  await db.pool.query(`INSERT INTO network.dot_monitor_owners SELECT environment,person_id,client_id,resource FROM network.dot_oauth_grants WHERE id=$1`,[identity.grant_id]);
  const data={name:'Fornecedor '+randomUUID(),idempotency_key:randomUUID()};
  expect(await approve('cadastrar_fornecedor',data)).not.toHaveProperty('isError');
  expect((await db.pool.query("SELECT 1 FROM commerce.wholesale_suppliers WHERE environment='test' AND name=$1",[data.name])).rowCount).toBe(1);
  const price={product_id:productId,price_amount:300,reason:'Teste revogação',idempotency_key:randomUUID()};
  const proposal=await call('alterar_preco_catalogo',price);
  await call('confirmar_operacao_milly',{proposta:proposal.proposta,fingerprint:proposal.fingerprint,autorizado_pelo_dono:true});
  await db.pool.query('UPDATE network.dot_oauth_grants SET catalog_operations_enabled=false WHERE id=$1',[identity.grant_id]);
  expect((await call('alterar_preco_catalogo',price)).isError).toBe(true);
});
it('publicador usa a mesma confirmação para cancelar, agendar, reagendar e excluir',async()=>{
  for(const [name,extra] of [
    ['cancelar_publicacao',{}],['publicar_ou_agendar_post',{agendado_para:null}],
    ['reagendar_publicacao',{agendado_para:'2099-01-01T15:00:00-03:00'}],
    ['excluir_publicacao_instagram',{confirmado:true}],
  ] as const){
    const result=await call(name,{post_id:randomUUID(),versao:1,idempotency_key:randomUUID(),...extra});
    expect(result).toMatchObject({status:'aguardando_autorizacao',confirmacao:'conversa',executada:false});
  }
});

it('opera ficha, atacado, contagem e separação/estorno de lote pelos serviços do painel',async()=>{
  expect(await approve('editar_ficha_catalogo',{product_id:productId,tread_pattern:'Touring',load_index:'91',speed_rating:'V',reason:'Ficha conferida',idempotency_key:randomUUID()})).toMatchObject({executada:true});
  const wholesale={product_id:productId,price_amount:180,reason:'Preço do dono',idempotency_key:randomUUID()};
  expect(await approve('alterar_preco_atacado_catalogo',wholesale)).toMatchObject({executada:true});
  expect(await approve('alterar_preco_atacado_catalogo',{...wholesale,price_amount:null,idempotency_key:randomUUID()})).toMatchObject({executada:true});
  const entry=await approve('registrar_entrada_estoque',{measure,brand,tire_condition:'novo',quantity_in:6,unit_cost:70,entry_nature:'opening_balance',reason:'Saldo conferido',idempotency_key:randomUUID()});
  const actualMeasure=entry.resultado.measure;
  const stock=(await db.pool.query("SELECT id FROM commerce.wholesale_stock WHERE environment='test' AND brand=$1",[brand])).rows[0];
  const input={kind:'to_lot',stock_id:stock.id,quantity:2,description:'Separação teste',reason:'Separação pedida pelo dono'};
  const preview=await call('simular_transferencia_estoque',{input});
  const transfer=await approve('confirmar_transferencia_estoque',{input,fingerprint:preview.fingerprint,idempotency_key:randomUUID()});
  expect(transfer).toMatchObject({executada:true});
  expect(await approve('estornar_transferencia_estoque',{id:transfer.resultado.id,reason:'Estorno pedido pelo dono',idempotency_key:randomUUID()})).toMatchObject({executada:true});
  expect(await approve('registrar_contagem_estoque',{rows:[{measure:actualMeasure,brand,tire_condition:'novo',counted_quantity:5}],reason:'Contagem realizada pelo dono',idempotency_key:randomUUID()})).toMatchObject({executada:true});
  expect((await db.pool.query('SELECT quantity_on_hand FROM commerce.wholesale_stock WHERE id=$1',[stock.id])).rows[0].quantity_on_hand).toBe(5);
  expect(await call('consultar_ficha_catalogo',{product_id:productId})).not.toHaveProperty('isError');
});

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

async function createPickup() {
  const unit=(await db.pool.query(`INSERT INTO core.units(environment,slug,name,is_active) VALUES('test','main','Matriz',true)
    ON CONFLICT (environment,slug) DO UPDATE SET name=EXCLUDED.name RETURNING id`)).rows[0].id;
  const contact=(await db.pool.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name)
    VALUES('test',$1,'Cliente de retirada') RETURNING id`,[randomBytes(5).readUIntBE(0,5)])).rows[0].id;
  const size=(await db.pool.query(`SELECT tire_size FROM commerce.tire_specs WHERE environment='test' AND product_id=$1`,[productId])).rows[0].tire_size;
  const stock=(await db.pool.query(`INSERT INTO commerce.wholesale_stock(environment,measure,brand,tire_condition,quantity_on_hand,unit_cost)
    VALUES('test',$1,$2,'novo',3,40) ON CONFLICT (environment,measure,brand,tire_condition)
    DO UPDATE SET quantity_on_hand=3,quantity_reserved=0,unit_cost=40 RETURNING id`,[size,brand])).rows[0].id;
  const {id,order_number}=(await db.pool.query(`INSERT INTO commerce.orders(environment,contact_id,total_amount,status,fulfillment_mode,
    payment_method,unit_id,source,idempotency_key) VALUES('test',$1,80,'open','pickup','A receber',$2,'chatwoot_com_bot',$3)
    RETURNING id,order_number`,[contact,unit,'bot:order:'+randomUUID()])).rows[0];
  await db.pool.query(`INSERT INTO commerce.order_items(environment,order_id,product_id,quantity,unit_price,
    discount_amount,reference_unit_price,matriz_unit_cost) VALUES('test',$1,$2,1,80,0,80,40)`,[id,productId]);
  const {reserveMatrizGalpaoStock}=await import('../../src/atendente-v2/matriz-stock-reservation.js');
  const {transact}=await import('../../src/admin/dot/installment-reviews.js');
  await transact(client=>reserveMatrizGalpaoStock(client,'test',id,[{productId,quantity:1}],true));
  return {id,order_number,size,stock};
}

it('Milly identifica a retirada e libera a reserva só uma vez após confirmação em voz ou texto',async()=>{
  const order=await createPickup();
  const {updateMatrizPickupStage}=await import('../../src/admin/painel/queries-pickups.js');
  await updateMatrizPickupStage({order_id:order.id,stage:'ready',services:[],actor_label:'Operador',environment:'test'},db.pool);
  const queue=await call('consultar_retiradas_matriz',{referencia:order.id});
  expect(queue.rows).toEqual([expect.objectContaining({id:order.id,stage:'pronto_para_retirar',reservation_expires_at:expect.any(String)})]);
  const candidate=await call('consultar_retirada_para_cancelar',{numero_pedido:order.order_number.replace(/^PED-0*/, '')});
  expect(candidate.ficha).toMatchObject({retirada_id:order.id,numero_pedido:order.order_number,
    cliente:'Cliente de retirada',total:'80.00',itens:[{medida:order.size,marca:brand,quantidade:1}]});
  const cancel={retirada_id:order.id,revisao:candidate.revisao,motivo:'Cliente desistiu',idempotency_key:randomUUID()};
  const blocked=await call('cancelar_retirada_matriz',cancel);
  expect(blocked.isError).toBe(true);
  await db.pool.query(`UPDATE network.dot_oauth_grants SET pickup_operations_enabled=true WHERE id=$1`,[identity.grant_id]);
  const pending=await call('cancelar_retirada_matriz',cancel);
  expect(pending).toMatchObject({status:'aguardando_autorizacao',confirmacao:'conversa',executada:false,
    dados:{ficha:candidate.ficha,motivo:cancel.motivo}});
  const state=async()=> (await db.pool.query(`SELECT o.status,s.quantity_on_hand,s.quantity_reserved
    FROM commerce.orders o JOIN commerce.wholesale_stock s ON s.id=$2 WHERE o.id=$1`,[order.id,order.stock])).rows[0];
  expect(await state()).toEqual({status:'open',quantity_on_hand:3,quantity_reserved:1});
  const confirm={proposta:pending.proposta,fingerprint:pending.fingerprint,autorizado_pelo_dono:true};
  const other=await grant(identity.person_id,identity.collaborator_id);
  expect((await call('confirmar_operacao_milly',confirm,other)).isError).toBe(true);
  expect(await call('confirmar_operacao_milly',confirm)).toMatchObject({status:'autorizada',executada:false});
  expect(await state()).toMatchObject({status:'open',quantity_reserved:1});
  const results=await Promise.all([call('cancelar_retirada_matriz',cancel),call('cancelar_retirada_matriz',cancel)]);
  expect(results[0]).toEqual(results[1]);
  expect(results[0]).toMatchObject({status:'executada',resultado:{cancelled:true,retirada_id:order.id}});
  expect(await state()).toEqual({status:'cancelled',quantity_on_hand:3,quantity_reserved:0});
  expect(await call('consultar_proposta_milly',{proposta:pending.proposta})).toMatchObject({status:'executada'});
});

it('Milly recusa cancelamento com ficha alterada depois do aval e restringe proposta ao canal permitido',async()=>{
  const order=await createPickup();
  await db.pool.query(`UPDATE network.dot_oauth_grants SET pickup_operations_enabled=true WHERE id=$1`,[identity.grant_id]);
  const candidate=await call('consultar_retirada_para_cancelar',{retirada_id:order.id});
  const cancel={retirada_id:order.id,revisao:candidate.revisao,motivo:'Cliente desistiu',idempotency_key:randomUUID()};
  const pending=await call('cancelar_retirada_matriz',cancel);
  await call('confirmar_operacao_milly',{proposta:pending.proposta,fingerprint:pending.fingerprint,autorizado_pelo_dono:true});
  const {updateMatrizPickupStage}=await import('../../src/admin/painel/queries-pickups.js');
  await updateMatrizPickupStage({order_id:order.id,stage:'arrived',services:[],actor_label:'Operador',environment:'test'},db.pool);
  const stale=await call('cancelar_retirada_matriz',cancel);
  expect(stale).toMatchObject({isError:true,text:[{text:'retirada_alterada_consulte_novamente'}]});
  expect((await db.pool.query('SELECT status FROM commerce.orders WHERE id=$1',[order.id])).rows[0].status).toBe('open');
  await db.pool.query(`UPDATE network.dot_oauth_grants SET operation_confirmation='legacy' WHERE id=$1`,[identity.grant_id]);
  const updated=await call('consultar_retirada_para_cancelar',{retirada_id:order.id});
  const panel=await call('cancelar_retirada_matriz',{...cancel,revisao:updated.revisao,idempotency_key:randomUUID()});
  expect(panel).toMatchObject({status:'aguardando_autorizacao',confirmacao:'painel',executada:false});
  expect(panel.confirm_url).toContain('/admin/dot/connections?operacao=');
  expect((await call('confirmar_operacao_milly',{proposta:panel.proposta,fingerprint:panel.fingerprint,autorizado_pelo_dono:true})).isError).toBe(true);
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

it('Milly encontra as referências antigas ao cadastrar e só classifica as escolhidas pelo dono', async () => {
  const { importVehicleApplications } = await import('../../scripts/vehicle-application-import.js');
  const client = await db.pool.connect();
  try { await importVehicleApplications(client, 'test'); } finally { client.release(); }
  await db.pool.query("UPDATE commerce.vehicle_measure_applications SET vehicle_type=NULL WHERE environment='test' AND display_measure='100/90-19'");
  const created = await approve('cadastrar_produto_catalogo', {creation_mode:'manual',measure:'100/90-19',brand,
    tire_condition:'meia_vida',product_code:'TEST-'+randomUUID(),product_name:'Pirelli de teste',vehicle_type:'motorcycle',idempotency_key:randomUUID()});
  const refs = created.resultado.referencias_para_classificar;
  expect(refs).toHaveLength(5);
  const id = created.resultado.product_id;
  const before = await call('consultar_ficha_catalogo',{product_id:id});
  expect(before.compatibilidades).toMatchObject({applications:[],rows:[],referencias_para_classificar:refs});
  const data = {measure:'100/90-19',application_ids:[refs[0].application_id],idempotency_key:randomUUID()};
  const result = await approve('classificar_referencias_moto',data);
  expect(result.resultado.changed).toBe(1);
  expect(await call('classificar_referencias_moto',data)).toEqual(result);
  const stale = await approve('classificar_referencias_moto',{...data,application_ids:[refs[1].application_id,refs[0].application_id],idempotency_key:randomUUID()});
  expect(stale.isError).toBe(true);
  const after = (await call('consultar_ficha_catalogo',{product_id:id})).compatibilidades;
  expect(after.applications.map((r:any)=>r.application_id)).toEqual(data.application_ids);
  expect(after.referencias_para_classificar).toHaveLength(4);
  expect(after.rows).toEqual([]);
  const audit = await db.pool.query("SELECT actor_label FROM audit.events WHERE event_type='catalog_application_vehicle_type_repaired'");
  expect(audit.rows).toEqual([{actor_label:'Milly · '+identity.person_id}]);
});

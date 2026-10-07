import {beforeAll,afterAll,it,expect} from 'vitest';
import {startPostgres,stopPostgres,type IntegrationDb} from './helpers/postgres.js';
let db:IntegrationDb;
let register:typeof import('../../src/atendente-v2/stock-interest.js').registerStockInterest;
let queue:typeof import('../../src/admin/stock-waitlist.js');
let serial=810000;
beforeAll(async()=>{
  Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgres://unused',CHATWOOT_HMAC_SECRET:'fake',ADMIN_AUTH_TOKEN:'fake',CHATWOOT_ACCOUNT_ID:'2'});
  db=await startPostgres();
  register=(await import('../../src/atendente-v2/stock-interest.js')).registerStockInterest;
  queue=await import('../../src/admin/stock-waitlist.js');
  await db.pool.query(`SELECT * FROM ops.ensure_monthly_partitions(2)`);
},180000);
afterAll(async()=>{if(db)await stopPostgres(db);});
async function conversation(channel='instagram',account=2,environment='test'){
  const n=++serial;
  const ct=(await db.pool.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name,phone_e164)
    VALUES($1,$2,'Cliente de teste','+5521988887777') RETURNING id`,[environment,n])).rows[0].id;
  return (await db.pool.query(`INSERT INTO core.conversations(environment,chatwoot_conversation_id,chatwoot_account_id,contact_id,channel_type,current_status,started_at)
    VALUES($1,$2,$3,$4,$5,'open',now()) RETURNING id,chatwoot_conversation_id`,[environment,n,account,ct,channel])).rows[0];
}
async function message(c:any,text:string,type=0,ago=0,environment='test'){
  return (await db.pool.query(`INSERT INTO core.messages(environment,chatwoot_message_id,conversation_id,chatwoot_conversation_id,sender_type,message_type,content,sent_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,now()-$8::integer*interval '1 second') RETURNING id`,
    [environment,++serial,c.id,c.chatwoot_conversation_id,type===0?'contact':'user',type,text,ago])).rows[0].id;
}
const consent='Pode me avisar no WhatsApp 21 98888-7777';
const args={acao:'registrar',medida:'90/90-12',condicao:'meia_vida',telefone:'21988887777',consentimento:consent,quantidade:2,tipo_veiculo:'motorcycle'};
async function call(c:any,a:any=args){const client=await db.pool.connect();try{await client.query('BEGIN');const r=await register(client,'test',c.id,a);await client.query('COMMIT');return r;}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}
it('rejeita consentimento inventado, telefone não informado e sim sem oferta real',async()=>{
  const c=await conversation();expect(await call(c)).toMatchObject({erro:'autorizacao_nao_confirmada'});
  await message(c,'Sim');expect(await call(c,{...args,consentimento:'Sim'})).toMatchObject({erro:'consentimento_ou_telefone_pendente'});
  // Uma pergunta escrita pelo próprio cliente não é oferta do bot.
  await message(c,'Quer que eu te avise no WhatsApp quando chegar?',0,2);await message(c,'sim');
  expect(await call(c,{...args,consentimento:'sim'})).toMatchObject({erro:'consentimento_ou_telefone_pendente'});
  await message(c,consent);expect(await call(c,{...args,telefone:'21999998888'})).toMatchObject({erro:'consentimento_ou_telefone_pendente'});
});
let interestId:string,stockId:string;
it('aceita sim após oferta de WhatsApp, captura telefone separado e não duplica entre canais',async()=>{
  const c=await conversation();await message(c,'Quer que eu te avise pelo WhatsApp quando chegar?',1,20);
  await message(c,'Sim',0,19);await message(c,'Me passa teu WhatsApp com DDD?',1,18);await message(c,'21 98888-7777',0,17);
  expect(await call(c,{...args,consentimento:'Sim'})).toMatchObject({registrado:true});
  expect(await call(c,{...args,consentimento:'Sim'})).toMatchObject({registrado:true});
  const other=await conversation('facebook');await message(other,consent);expect(await call(other)).toMatchObject({registrado:true});
  const all=await db.pool.query(`SELECT * FROM ops.stock_interests`);expect(all.rowCount).toBe(1);interestId=all.rows[0].id;
  expect(all.rows[0]).toMatchObject({quantity:2,vehicle_type:'motorcycle',phone_e164:'+5521988887777',status:'pending',offer_text:'Quer que eu te avise pelo WhatsApp quando chegar?'});
  expect((await db.pool.query('SELECT * FROM commerce.orders')).rowCount).toBe(0);
});
it('reutiliza número válido da conversa WhatsApp sem exigir que cliente o digite',async()=>{
  const c=await conversation('whatsapp');await message(c,'Quer que eu te avise pelo WhatsApp quando chegar?',1,20);await message(c,'Pode sim',0,19);
  expect(await call(c,{...args,medida:'110/70-17',telefone:'',consentimento:'Pode sim'})).toMatchObject({registrado:true});
});
it('consulta quantidade livre, desconta reservas, diferencia veículo e mantém cadastro vazio indisponível',async()=>{
  expect((await queue.waitlistRows(db.pool,'test',2)).find(r=>r.id===interestId)).toMatchObject({available:false,available_quantity:0});
  stockId=(await db.pool.query(`INSERT INTO commerce.wholesale_stock(environment,measure,brand,tire_condition,quantity_on_hand,quantity_reserved,unit_cost,vehicle_type)
    VALUES('test','90/90-12','Teste','meia_vida',3,2,25,'motorcycle') RETURNING id`)).rows[0].id;
  let rows=await queue.waitlistRows(db.pool,'test',2);expect(rows.find(r=>r.id===interestId)).toMatchObject({available:false,available_quantity:1});
  await db.pool.query(`UPDATE commerce.wholesale_stock SET quantity_reserved=1 WHERE id=$1`,[stockId]);
  rows=await queue.waitlistRows(db.pool,'test',2);expect(rows.find(r=>r.id===interestId)).toMatchObject({available:true,available_quantity:2});
  await expect(db.pool.query(`UPDATE commerce.wholesale_stock SET vehicle_type='car' WHERE id=$1`,[stockId])).rejects.toThrow('operation_vehicle_type_conflict');
  await db.pool.query(`INSERT INTO commerce.wholesale_stock(environment,measure,brand,tire_condition,quantity_on_hand,quantity_reserved,unit_cost,vehicle_type)
    VALUES('test','90/90-12','Outra marca','meia_vida',10,0,25,'car')`);
  await db.pool.query(`UPDATE commerce.wholesale_stock SET quantity_on_hand=1 WHERE id=$1`,[stockId]);
  expect((await queue.waitlistRows(db.pool,'test',2)).find(r=>r.id===interestId)?.available).toBe(false);
  await db.pool.query(`UPDATE commerce.wholesale_stock SET quantity_on_hand=3,unit_cost=0 WHERE id=$1`,[stockId]);
  expect((await queue.waitlistRows(db.pool,'test',2)).find(r=>r.id===interestId)?.available).toBe(false);
  await db.pool.query(`UPDATE commerce.wholesale_stock SET unit_cost=25 WHERE id=$1`,[stockId]);
});
it('não mistura ambientes, contas Chatwoot ou contatos apagados',async()=>{
  const c=await conversation('instagram',9);const msg=await message(c,consent);
  await db.pool.query(`INSERT INTO ops.stock_interests(environment,conversation_id,source_message_id,tire_size,tire_condition,phone_e164,consent_text,consent_at,quantity,vehicle_type)
    VALUES('test',$1,$2,'175-65-14','meia_vida','+5521977776666',$3,now(),1,'car')`,[c.id,msg,consent]);
  expect((await queue.waitlistRows(db.pool,'test',2)).some(r=>r.conversation_id===c.id)).toBe(false);
  expect(await queue.waitlistRows(db.pool,'prod',2)).toEqual([]);
  expect((await queue.waitlistRows(db.pool,'test',9)).length).toBe(1);
});
it('filtra e pagina sem alterar resumo, conta pessoas distintas e quantidade confirmada',async()=>{
  const rows=await queue.waitlistRows(db.pool,'test',2),report=queue.waitlistReport(rows,{search:'',region:'',vehicle:'',status:'ready',offset:0});
  expect(report.summary).toMatchObject({clients:1,quantity:4,ready:1,notified:0});
  expect(report.total).toBe(1);expect(report.rows[0].id).toBe(interestId);
  expect(queue.waitlistReport(rows,{search:'inexistente',region:'',vehicle:'',status:'all',offset:0}).total).toBe(0);
  expect(queue.waitlistReport(rows,{search:'',region:'',vehicle:'car',status:'all',offset:0}).total).toBe(0);
});
it('abrir a lista não marca aviso; alteração tem controle de concorrência e auditoria',async()=>{
  await queue.waitlistRows(db.pool,'test',2);
  expect((await db.pool.query(`SELECT status FROM ops.stock_interests WHERE id=$1`,[interestId])).rows[0].status).toBe('pending');
  expect(await queue.changeWaitlistStatus(interestId,0,'contacted','teste',db.pool)).toMatchObject({status:'contacted',version:1});
  await expect(queue.changeWaitlistStatus(interestId,0,'cancelled','teste',db.pool)).rejects.toThrow('waitlist_conflict');
  const row=(await queue.waitlistRows(db.pool,'test',2)).find(r=>r.id===interestId)!;
  expect(row.contacted_at).toBeTruthy();expect(row.available).toBe(false);
  const events=await db.pool.query(`SELECT from_status,to_status,actor FROM ops.stock_interest_events WHERE interest_id=$1 ORDER BY occurred_at`,[interestId]);
  expect(events.rows).toHaveLength(2);expect(events.rows[1]).toMatchObject({from_status:'pending',to_status:'contacted',actor:'teste'});
  await expect(db.pool.query(`UPDATE ops.stock_interest_events SET actor='outro' WHERE interest_id=$1`,[interestId])).rejects.toThrow('immutable');
  expect((await db.pool.query(`SELECT quantity_on_hand,quantity_reserved FROM commerce.wholesale_stock WHERE id=$1`,[stockId])).rows[0]).toMatchObject({quantity_on_hand:3,quantity_reserved:1});
});
it('protege auditoria com RLS e rejeita evento em ambiente diferente',async()=>{
  expect((await db.pool.query(`SELECT has_table_privilege('farejador_partner_app','ops.stock_interest_events','SELECT') AS allowed`)).rows[0].allowed).toBe(false);
  await expect(db.pool.query(`INSERT INTO ops.stock_interest_events(environment,interest_id,to_status,actor) VALUES('prod',$1,'pending','fake')`,[interestId])).rejects.toThrow('scope_mismatch');
});
it('serializa dois aceites simultâneos do mesmo WhatsApp sem duplicar interesse',async()=>{
  const a=await conversation(),b=await conversation('facebook');
  await message(a,consent);await message(b,consent);
  const input={...args,medida:'100/80-17'};
  const results=await Promise.all([call(a,input),call(b,input)]);
  results.forEach(r=>expect(r).toMatchObject({registrado:true}));
  expect((await db.pool.query(`SELECT id FROM ops.stock_interests WHERE tire_size='100-80-17'`)).rowCount).toBe(1);
});
it('não usa autorização antiga depois de uma recusa mais recente',async()=>{
  const c=await conversation();await message(c,consent,0,10);await message(c,'Não preciso mais do aviso');
  expect(await call(c,{...args,medida:'80/100-18'})).toMatchObject({erro:'novo_consentimento_necessario'});
  expect((await db.pool.query(`SELECT id FROM ops.stock_interests WHERE tire_size='80-100-18'`)).rowCount).toBe(0);
});

it('aceite informal pelo WhatsApp usa o telefone do contato mesmo quando a tool omite telefone',async()=>{
  const c=await conversation('whatsapp');
  await message(c,'O 180/55-17 tá em falta. Quer que eu te avise pelo WhatsApp quando chegar?',1,20);
  await message(c,'Pode ser de boa',0,19);
  const {telefone:_,...input}=args;
  expect(await call(c,{...input,medida:'180/55-17',consentimento:'Pode ser de boa',quantidade:1})).toMatchObject({registrado:true});
  const rows=await db.pool.query(`SELECT phone_e164,consent_text,quantity FROM ops.stock_interests WHERE environment='test' AND conversation_id=$1`,[c.id]);
  expect(rows.rows).toEqual([{phone_e164:'+5521988887777',consent_text:'Pode ser de boa',quantity:1}]);
  expect((await db.pool.query(`SELECT id FROM commerce.orders WHERE environment='test'`)).rowCount).toBe(0);
});

it('telefone omitido em canal social ou número inválido explícito não usa fallback para registrar',async()=>{
  const {telefone:_,...input}=args;
  for(const channel of ['instagram','facebook','whatsapp']){
    const c=await conversation(channel);await message(c,'Quer que eu te avise pelo WhatsApp quando chegar?',1,20);await message(c,'Pode ser de boa',0,19);
    const a={...input,medida:'180/55-17',consentimento:'Pode ser de boa',...(channel==='whatsapp'?{telefone:'2198765565'}:{})};
    expect(await call(c,a)).toMatchObject({erro:'consentimento_ou_telefone_pendente'});
    expect((await db.pool.query(`SELECT id FROM ops.stock_interests WHERE environment='test' AND conversation_id=$1`,[c.id])).rowCount).toBe(0);
  }
});

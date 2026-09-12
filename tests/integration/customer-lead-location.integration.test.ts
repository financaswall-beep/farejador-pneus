import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('localização do lead — seleção real no PostgreSQL isolado',() => {
  let db:IntegrationDb;
  let locations:typeof import('../../src/admin/painel/customer-lead-location.js').loadCustomerLeadLocations;
  let detail:typeof import('../../src/admin/painel/customer-detail.js').getCustomerDetail;
  let board:typeof import('../../src/admin/painel/queries-clientes.js').getClientesPainel;
  let contact:string, other:string, legacyContact:string, conversation:string, secondConversation:string;
  let factVersion=0, messageId=991200;
  const id=async(sql:string,args:unknown[]=[]) => (await db.pool.query(sql,args)).rows[0].id as string;
  const fact=async(cv:string,key:string,value:unknown,date:string) => id(
    `INSERT INTO analytics.conversation_facts(environment,conversation_id,fact_key,fact_value,
      observed_at,truth_type,source,confidence_level,extractor_version)
     VALUES('test',$1,$2,$3,$4,'observed','location_fixture',1,$5) RETURNING id`,
    [cv,key,JSON.stringify(value),date,String(++factVersion)]);
  const typed=(bairro:string,municipio:string) => ({tipo:'regiao_digitada',texto_informado:`${bairro}, ${municipio}`,bairro,municipio});
  beforeAll(async() => {
    Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgres://test',
      CHATWOOT_HMAC_SECRET:'test-secret',ADMIN_AUTH_TOKEN:'test-admin'});
    db=await startPostgres();process.env.DATABASE_URL=db.connectionString;vi.resetModules();
    locations=(await import('../../src/admin/painel/customer-lead-location.js')).loadCustomerLeadLocations;
    detail=(await import('../../src/admin/painel/customer-detail.js')).getCustomerDetail;
    board=(await import('../../src/admin/painel/queries-clientes.js')).getClientesPainel;
    contact=await id(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name) VALUES('test',991201,'Cliente local') RETURNING id`);
    other=await id(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name) VALUES('test',991202,'Cliente local') RETURNING id`);
    legacyContact=await id(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name) VALUES('test',991203,'Legado') RETURNING id`);
    conversation=await id(`INSERT INTO core.conversations(environment,chatwoot_conversation_id,chatwoot_account_id,contact_id,current_status,started_at)
      VALUES('test',991201,2,$1,'open','2026-04-01') RETURNING id`,[contact]);
    secondConversation=await id(`INSERT INTO core.conversations(environment,chatwoot_conversation_id,chatwoot_account_id,contact_id,current_status,started_at)
      VALUES('test',991202,2,$1,'open','2026-04-03') RETURNING id`,[contact]);
  },180_000);
  afterAll(async()=>{if(db)await stopPostgres(db);});

  it('ficha e quadro recuperam o local de outra conversa do mesmo contato',async()=>{
    await fact(conversation,'localizacao_lead',typed('Icaraí','Niterói'),'2026-04-01');
    const result=await board('test',db.pool);
    const row=result.rows.find(c=>c.source_id===contact);
    const ficha=await detail('test','chatwoot',contact,{},db.pool);
    expect(row?.lead_location).toBe('Icaraí — Niterói');
    expect(row?.shared_location).toEqual(ficha?.customer.shared_location);
    expect(ficha?.customer.address).toBeNull();
    expect(await locations('prod',[contact],db.pool)).toEqual(new Map());
  });
  it('publica o controle da conversa atual sem confundir etapa manual ou outra conversa do contato',async()=>{
    const {changeBotConversationControl}=await import('../../src/admin/painel/bot-conversation-control.js');
    const current=async()=>(await board('test',db.pool)).rows.find(c=>c.source_id===contact)!;
    expect(await current()).toMatchObject({lead_conversation_id:secondConversation,lead_bot_mode:'auto',lead_bot_version:0});
    await changeBotConversationControl({conversationId:conversation,action:'takeover',expectedVersion:0,actor:'test'},db.pool);
    expect((await current()).lead_bot_mode).toBe('auto');
    await changeBotConversationControl({conversationId:secondConversation,action:'takeover',expectedVersion:0,actor:'test'},db.pool);
    expect(await current()).toMatchObject({lead_bot_mode:'human',lead_bot_version:1});
    await changeBotConversationControl({conversationId:secondConversation,action:'resume',expectedVersion:1,actor:'test'},db.pool);
    expect(await current()).toMatchObject({lead_bot_mode:'auto',lead_bot_version:2});
    expect((await board('prod',db.pool)).rows).toEqual([]);
  });
  it('usa a correção vigente e ignora fatos vazios e conversas excluídas',async()=>{
    const corrected=await fact(secondConversation,'localizacao_lead',typed('Centro','Maricá'),'2026-04-04');
    const superseded=await fact(conversation,'localizacao_lead',typed('Centro','Rio de Janeiro'),'2026-04-06');
    await db.pool.query('UPDATE analytics.conversation_facts SET superseded_by=$1 WHERE id=$2',[corrected,superseded]);
    await fact(secondConversation,'localizacao_lead',{},'2026-04-07');
    const deleted=await id(`INSERT INTO core.conversations(environment,chatwoot_conversation_id,chatwoot_account_id,contact_id,current_status,deleted_at,started_at)
      VALUES('test',991204,2,$1,'open',now(),'2026-04-08') RETURNING id`,[contact]);
    await fact(deleted,'localizacao_lead',typed('Centro','São Gonçalo'),'2026-04-08');
    const foreign=await id(`INSERT INTO core.conversations(environment,chatwoot_conversation_id,chatwoot_account_id,contact_id,current_status,started_at)
      VALUES('test',991205,2,$1,'open','2026-04-09') RETURNING id`,[other]);
    await fact(foreign,'localizacao_lead',typed('Fonseca','Niterói'),'2026-04-09');
    const result=await locations('test',[contact,other],db.pool);
    expect(result.get(contact)?.label).toBe('Centro — Maricá');
    expect(result.get(other)?.label).toBe('Fonseca — Niterói');
  });
  it('campos antigos são fallback e não substituem a localização estruturada',async()=>{
    await fact(secondConversation,'bairro_consultado','Inoã','2026-04-10');
    const legacy=await id(`INSERT INTO core.conversations(environment,chatwoot_conversation_id,chatwoot_account_id,contact_id,current_status,started_at)
      VALUES('test',991206,2,$1,'open','2026-04-10') RETURNING id`,[legacyContact]);
    await fact(legacy,'bairro_consultado','Rio do Ouro','2026-04-10');
    const result=await locations('test',[contact,legacyContact],db.pool);
    expect(result.get(contact)?.label).toBe('Centro — Maricá');
    expect(result.get(legacyContact)).toMatchObject({source:'legacy',label:'Rio do Ouro'});
  });
  it('considera somente pinos do cliente, com desempate estável e leitura do cache em lote',async()=>{
    for(const sender of ['contact','agent_bot']){
      const incoming=sender==='contact',stamp=incoming?'2026-04-12':'2026-04-13';
      const message=await id(`INSERT INTO core.messages(environment,conversation_id,chatwoot_message_id,sender_type,message_type,sent_at,chatwoot_conversation_id)
        VALUES('test',$1,$2,$3,$4,$5,991201) RETURNING id`,[conversation,++messageId,sender,incoming?0:1,stamp]);
      await db.pool.query(`INSERT INTO core.message_attachments(environment,conversation_id,message_id,chatwoot_attachment_id,file_type,
        coordinates_lat,coordinates_lng,created_at) VALUES('test',$1,$2,$3,'location',$4,$5,$6)`,
        [conversation,message,++messageId,incoming?-22.9:-22.8,incoming?-43.1:-43.2,stamp]);
    }
    await fact(secondConversation,'localizacao_lead',typed('Centro','Maricá'),'2026-04-12');
    await db.pool.query(`INSERT INTO commerce.geo_cache(cache_key,kind,value) VALUES('r:-22.9000,-43.1000','reverse',$1::jsonb)`,
      [JSON.stringify({neighborhood:'Icaraí',municipio:'Niterói',formattedAddress:'Icaraí, Niterói'})]);
    const result=await locations('test',[contact],db.pool);
    expect(result.get(contact)).toMatchObject({source:'shared_pin',label:'Icaraí — Niterói'});
    expect(result.get(contact)?.maps_url).toContain('-22.9%2C-43.1');
  });
  it('publica as duas medidas com preços vinculados e ignora turnos não enviados e outros ambientes',async()=>{
    const ct=await id(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name) VALUES('test',991300,'Duas medidas') RETURNING id`);
    const cv=await id(`INSERT INTO core.conversations(environment,chatwoot_conversation_id,chatwoot_account_id,contact_id,current_status,started_at)
      VALUES('test',991300,2,$1,'open','2026-09-12') RETURNING id`,[ct]);
    const message=await id(`INSERT INTO core.messages(environment,conversation_id,chatwoot_message_id,sender_type,message_type,sent_at,chatwoot_conversation_id)
      VALUES('test',$1,991301,'contact',0,'2026-09-12',991300) RETURNING id`,[cv]);
    const actions=[{role:'assistant',tool_calls:[
      {id:'a',function:{name:'buscar_produto',arguments:JSON.stringify({medida_pneu:'130/70-13'})}},
      {id:'b',function:{name:'buscar_produto',arguments:JSON.stringify({medida_pneu:'110/70-13'})}},
    ]},{role:'tool',tool_call_id:'a',content:JSON.stringify({encontrado:false,mensagem:'Nenhum produto com estoque encontrado.'})},
    {role:'tool',tool_call_id:'b',content:JSON.stringify({encontrado:true,produtos:[{
      product_id:'p110',product_name:'Pneu 110/70-13',tire_size:'110/70-13',tire_condition:'meia_vida',brand:'IRC',
      price_amount:'89',currency:'BRL',total_stock_available:7,
    }]})}];
    await db.pool.query(`INSERT INTO agent.turns(environment,conversation_id,trigger_message_id,agent_version,context_hash,status,actions)
      VALUES('test',$1,$2,'v2','test','sent_api_ack',$3::jsonb)`,[cv,message,JSON.stringify(actions)]);
    await db.pool.query(`INSERT INTO ops.bot_stock_searches(environment,conversation_id,search_key,tool_name,measure,filters,stores,trigger_message_id)
      VALUES('test',$1,'lead-multi-test','buscar_produto','130/70-13','{}',$2::jsonb,$3)`,
      [cv,JSON.stringify([{id:'matriz',kind:'matrix',name:'Matriz',available:false}]),message]);
    await fact(cv,'medida_consultada','130/70-13','2026-09-12');
    await fact(cv,'medida_consultada','130 70 13','2026-09-12');
    await fact(cv,'preco_cotado',999,'2026-09-12');
    const valid=await fact(cv,'medida_consultada','110/70-13','2026-09-12');
    const corrected=await fact(cv,'medida_consultada','180/55-17','2026-09-12');
    await db.pool.query('UPDATE analytics.conversation_facts SET superseded_by=$1 WHERE id=$2',[valid,corrected]);
    const unsent=await id(`INSERT INTO core.messages(environment,conversation_id,chatwoot_message_id,sender_type,message_type,sent_at,chatwoot_conversation_id)
      VALUES('test',$1,991302,'contact',0,'2026-09-12',991300) RETURNING id`,[cv]);
    await db.pool.query(`INSERT INTO agent.turns(environment,conversation_id,trigger_message_id,agent_version,context_hash,status,actions)
      VALUES('test',$1,$2,'v2','test','generated',$3::jsonb)`,[cv,unsent,JSON.stringify(actions).replaceAll('110/70-13','180/55-17')]);
    const data=await board('test',db.pool), row=data.rows.find(c=>c.source_id===ct)!;
    expect(row.lead_interests).toHaveLength(2);
    expect(row.lead_interests?.find(i=>i.measure==='130/70-13')?.variants[0]).toMatchObject({quotes:[],availability:'unavailable'});
    expect(row.lead_interests?.find(i=>i.measure==='110/70-13')?.variants[0]).toMatchObject({condition:'meia_vida',quotes:[{product_id:'p110',amount:89}]});
    const {loadCustomerLeadInterests}=await import('../../src/admin/painel/customer-lead-interests.js');
    expect((await loadCustomerLeadInterests('prod',[cv],db.pool)).get(cv)).toEqual([]);
  });
});

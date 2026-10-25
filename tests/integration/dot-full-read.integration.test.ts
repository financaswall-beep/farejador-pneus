import {beforeAll,afterAll,expect,it,vi} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import {startPostgres,stopPostgres,type IntegrationDb} from './helpers/postgres.js';
import {businessDateSaoPaulo} from '../../src/shared/business-time.js';
let db:IntegrationDb;
let run:typeof import('../../src/admin/dot/consultations.js').runDotConsultation;
let sources:typeof import('../../src/admin/dot/full-catalog.js').fullSources;
beforeAll(async()=>{
  Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgres://test',DATABASE_SSL:'false',
    CHATWOOT_HMAC_SECRET:'test-secret',CHATWOOT_ACCOUNT_ID:'1',ADMIN_AUTH_TOKEN:'test-emergency',DOT_MCP_ENABLED:'false',
    MATRIZ_CENTRAL_LEDGER:'true',MATRIZ_CENTRAL_LEDGER_READ:'true',MATRIZ_LOGISTICS:'true',WHOLESALE_FINANCE:'true'});
  db=await startPostgres({timeZone:'UTC'});process.env.DATABASE_URL=db.connectionString;vi.resetModules();
  expect((await db.pool.query("SELECT current_setting('TimeZone') zone")).rows[0].zone).toBe('UTC');
  run=(await import('../../src/admin/dot/consultations.js')).runDotConsultation;
  sources=(await import('../../src/admin/dot/full-catalog.js')).fullSources;
},240000);
afterAll(async()=>{await(await import('../../src/persistence/db.js')).pool.end();if(db)await stopPostgres(db);});

it('todas as fontes explícitas executam no schema real dentro de transação somente leitura',async()=>{
  const failures:string[]=[];
  for(const source of sources)try {
    const result=await run('consultar_registros_matriz',{fonte:source.key});
    expect(result).toMatchObject({read_only:true,environment:'test',fonte:source.key});
    expect(Array.isArray(result.registros)).toBe(true);
  }catch(e){failures.push(source.key+': '+(e as Error).message);}
  expect(failures).toEqual([]);
  const today=businessDateSaoPaulo(new Date());
  expect(await run('consultar_relatorio_painel',{relatorio:'financeiro',filtros:{from:today,to:today}})).toHaveProperty('resultado');
  expect(await run('consultar_extrato_matriz',{})).toMatchObject({available:true,rows:[]});
},120000);

it('dados pessoais autorizados são consultáveis, pagináveis e isolados de produção',async()=>{
  await db.pool.query(`INSERT INTO commerce.customers(environment,name,phone_e164,email,notes)
    SELECT 'test','Cliente autorizado '||i,'+552100000'||lpad(i::text,4,'0'),'cliente'||i||'@example.test','Anotação pessoal'
    FROM generate_series(1,55) i;
    INSERT INTO commerce.customers(environment,name,phone_e164) VALUES('prod','SEGREDO-PROD','+5521999999999');`);
  const before=(await db.pool.query(`SELECT md5(string_agg(to_jsonb(t)::text,'' ORDER BY id)) digest FROM commerce.customers t`)).rows[0];
  const pages=[];for(let pagina=1;pagina<=3;pagina++)pages.push(await run('consultar_registros_matriz',{fonte:'commerce.customers',pagina}));
  expect(pages[0]).toMatchObject({total:55,proxima_pagina:2});expect(pages[2]).toMatchObject({proxima_pagina:null});
  const rows=pages.flatMap(p=>p.registros as {id:string;name:string;phone_e164:string}[]);
  expect(new Set(rows.map(r=>r.id)).size).toBe(55);expect(rows.every(r=>r.name.startsWith('Cliente autorizado')&&r.phone_e164.startsWith('+5521'))).toBe(true);
  expect(JSON.stringify(pages)).not.toContain('SEGREDO-PROD');
  const search=await run('consultar_registros_matriz',{fonte:'commerce.customers',campos:['name','phone_e164'],filtros:[{campo:'name',operador:'contem',valor:'autorizado 55'}]});
  expect(search.registros).toEqual([expect.objectContaining({name:'Cliente autorizado 55',phone_e164:expect.any(String)})]);
  expect((await db.pool.query(`SELECT md5(string_agg(to_jsonb(t)::text,'' ORDER BY id)) digest FROM commerce.customers t`)).rows[0]).toEqual(before);
});

it('não publica credenciais, nem permite inferi-las por filtros ou ordenação',async()=>{
  const id=randomUUID();await db.pool.query(`INSERT INTO network.partner_people(id,environment,username,password_hash)
    VALUES($1,'test','usuario.autorizado','PASSWORD-SENTINEL')`,[id]);
  const result=await run('consultar_registros_matriz',{fonte:'network.partner_people'});
  expect(result.registros).toEqual([expect.objectContaining({id,username:'usuario.autorizado'})]);
  expect(JSON.stringify(result)).not.toMatch(/PASSWORD-SENTINEL|password_hash/);
  for(const extra of [{campos:['password_hash']},{ordenar_por:'password_hash'},
    {filtros:[{campo:'password_hash',valor:'PASSWORD-SENTINEL'}]}]) {
    await expect(run('consultar_registros_matriz',{fonte:'network.partner_people',...extra})).rejects.toThrow();
  }
  for(const fonte of ['network.dot_oauth_tokens','network.matriz_staff_sessions','raw.raw_events','commerce.customers; DELETE FROM commerce.customers']) {
    await expect(run('consultar_registros_matriz',{fonte})).rejects.toThrow();
  }
  await expect(run('consultar_registros_matriz',{fonte:'commerce.customers',environment:'prod'})).rejects.toThrow();
  expect(JSON.stringify(await run('listar_fontes_matriz',{fonte:'network.partner_people'}))).not.toContain('password_hash');
});

it('conversas e contatos completos continuam limitados à conta Chatwoot',async()=>{
  for(const [account,number,name] of [[1,81001,'PESSOA-AUTORIZADA'],[2,81002,'OUTRA-CONTA']] as const) {
    const contact=(await db.pool.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name,phone_e164)
      VALUES('test',$1,$2,'+5521999990000') RETURNING id`,[number,name])).rows[0].id;
    await db.pool.query(`INSERT INTO core.conversations(environment,chatwoot_account_id,chatwoot_conversation_id,contact_id,channel_type,current_status,started_at)
      VALUES('test',$1,$2,$3,'whatsapp','open',now())`,[account,number,contact]);
  }
  const result=await run('consultar_registros_matriz',{fonte:'core.contacts'});
  expect(result.registros).toEqual([expect.objectContaining({name:'PESSOA-AUTORIZADA',phone_e164:'+5521999990000'})]);
  const conversations=await run('consultar_registros_matriz',{fonte:'core.conversations'});
  expect(conversations.registros).toEqual([expect.objectContaining({chatwoot_account_id:1})]);
});

it('datas civis não mudam de dia e valores decimais aceitam filtro numérico',async()=>{
  await db.pool.query(`INSERT INTO commerce.matriz_expenses(environment,category,description,amount,occurred_at,document_date,payment_status,paid_at)
    VALUES('test','outros','Despesa autorizada',25,now(),'2026-01-02','paid',now())`);
  const result=await run('consultar_registros_matriz',{fonte:'commerce.matriz_expenses',campo_data:'document_date',de:'2026-01-02',ate:'2026-01-02',
    filtros:[{campo:'amount',valor:25}]});
  expect(result.total).toBe(1);expect(result.registros).toEqual([expect.objectContaining({description:'Despesa autorizada',amount:'25.00'})]);
});

it('relatórios completos reutilizam o painel e exportam somente a seção escolhida',async()=>{
  const today=businessDateSaoPaulo(new Date());
  for(const relatorio of ['vendas','compras','estoque','logistica','parceiros','demanda','faltas']) {
    const description=await run('consultar_relatorio_painel',{relatorio,descrever:true});expect(description.filtros).toBeTruthy();
    const filtros=relatorio==='estoque'?{}:{from:today,to:today};
    const report=await run('consultar_relatorio_painel',{relatorio,filtros});expect(report.resultado).toBeTruthy();
  }
  const csv=await run('consultar_relatorio_painel',{relatorio:'vendas',filtros:{from:today,to:today},secao:'export_sales',formato:'csv'});
  expect(csv).toMatchObject({formato:'csv',total:0,proxima_pagina:null});
  await expect(run('consultar_relatorio_painel',{relatorio:'vendas',filtros:{from:today,to:today,environment:'prod'}})).rejects.toThrow();
},60000);

it('comprovantes são bytes autenticados e não aparecem entre ambientes',async()=>{
  const bytes=Buffer.from([255,216,255,217]);
  const receipt=(await db.pool.query(`INSERT INTO commerce.matriz_expense_receipts(environment,content_sha256,mime,size_bytes,created_by)
    VALUES('test',$1,'image/jpeg',4,'qa') RETURNING id`,[createHash('sha256').update(bytes).digest()])).rows[0].id;
  await db.pool.query(`INSERT INTO commerce.matriz_expense_receipt_blobs(environment,receipt_id,bytes) VALUES('test',$1,$2)`,[receipt,bytes]);
  const result=await run('consultar_anexo_matriz',{tipo:'nota_despesa',id:receipt});
  expect(result).toMatchObject({mime:'image/jpeg',bytes:4,attachment:{data:bytes.toString('base64')}});
  await expect(run('consultar_anexo_matriz',{tipo:'nota_despesa',id:randomUUID()})).rejects.toThrow('attachment_not_found');
  await expect(run('consultar_anexo_matriz',{tipo:'nota_despesa',id:receipt,url:'http://localhost/'})).rejects.toThrow();
});

it('folha individual e despesas do parceiro estão liberadas para o proprietário',async()=>{
  const person=(await db.pool.query(`INSERT INTO network.partner_people(environment,username,password_hash)
    VALUES('test','funcionaria.autorizada','hash-fixture') RETURNING id`)).rows[0].id;
  const collaborator=(await db.pool.query(`INSERT INTO network.matriz_collaborators(environment,person_id,display_name,job,job_title,work_area,created_by)
    VALUES('test',$1,'Funcionária autorizada','entregador','Entregadora','delivery','qa') RETURNING id`,[person])).rows[0].id;
  await db.pool.query(`INSERT INTO network.matriz_collaborator_compensation(environment,collaborator_id,employment_type,base_salary,payment_day,starts_on,updated_by)
    VALUES('test',$1,'clt',2345.67,5,'2026-01-01','qa')`,[collaborator]);
  expect(await run('consultar_registros_matriz',{fonte:'network.matriz_collaborator_compensation',filtros:[{campo:'collaborator_id',valor:collaborator}]}))
    .toMatchObject({registros:[expect.objectContaining({base_salary:'2345.67'})]});
  const unit=(await db.pool.query(`INSERT INTO core.units(environment,slug,name) VALUES('test','partner-full-read','Loja teste') RETURNING id`)).rows[0].id;
  await db.pool.query(`INSERT INTO finance.partner_expenses(environment,unit_id,expense_date,category,description,amount,payment_method,created_by,idempotency_key)
    VALUES('test',$1,(now() AT TIME ZONE 'America/Sao_Paulo')::date,'other','Conta particular da loja',123.45,'pix','qa',$2)`,[unit,randomUUID()]);
  expect(await run('consultar_registros_matriz',{fonte:'finance.partner_expenses',filtros:[{campo:'unit_id',valor:unit}]}))
    .toMatchObject({registros:[expect.objectContaining({description:'Conta particular da loja',amount:'123.45'})]});
});

it('anexos de mensagens ou contatos apagados ficam indisponíveis',async()=>{
  const conversation=(await db.pool.query(`SELECT id FROM core.conversations WHERE environment='test' AND chatwoot_conversation_id=81001`)).rows[0].id;
  const message=(await db.pool.query(`INSERT INTO core.messages(environment,conversation_id,chatwoot_conversation_id,chatwoot_message_id,sender_type,message_type,content,sent_at)
    VALUES('test',$1,81001,81001,'contact',0,'Mensagem pessoal autorizada',now()) RETURNING id`,[conversation])).rows[0].id;
  const attachment=(await db.pool.query(`INSERT INTO core.message_attachments(environment,message_id,conversation_id,chatwoot_attachment_id,file_type,data_url)
    VALUES('test',$1,$2,81001,'image','https://invalid.example/photo.jpg') RETURNING id`,[message,conversation])).rows[0].id;
  expect(await run('consultar_registros_matriz',{fonte:'core.messages'})).toMatchObject({registros:[expect.objectContaining({content:'Mensagem pessoal autorizada'})]});
  expect(await run('consultar_registros_matriz',{fonte:'core.message_attachments'})).toMatchObject({total:1});
  await db.pool.query(`UPDATE core.contacts SET deleted_at=now() WHERE id=(SELECT contact_id FROM core.conversations WHERE id=$1)`,[conversation]);
  expect(await run('consultar_registros_matriz',{fonte:'core.message_attachments'})).toMatchObject({total:0});
  await expect(run('consultar_anexo_matriz',{tipo:'mensagem',id:attachment})).rejects.toThrow('attachment_not_found');
  await db.pool.query(`UPDATE core.contacts SET deleted_at=NULL WHERE id=(SELECT contact_id FROM core.conversations WHERE id=$1)`,[conversation]);
  await db.pool.query(`UPDATE core.messages SET deleted_at=now() WHERE environment='test' AND id=$1`,[message]);
  expect(await run('consultar_registros_matriz',{fonte:'core.message_attachments'})).toMatchObject({total:0});
  await expect(run('consultar_anexo_matriz',{tipo:'mensagem',id:attachment})).rejects.toThrow('attachment_not_found');
});

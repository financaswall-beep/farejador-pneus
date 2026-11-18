import { createHash } from 'node:crypto';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';
import { configureTestOpeningHours, atOpenStoreTime } from './helpers/store-opening-fixtures.js';
import * as milly from '../../src/atendente-v2/milly-negociacao.js';

let db:IntegrationDb, owner:string, product:string, unit:string, seq=9968000;
let execute:typeof import('../../src/atendente-v2/tools.js').executeTool;
const body='Consigo fazer um pneu por R$ 80,00 no Pix para retirada.';
beforeAll(async()=>{
  db=await startPostgres();
  await configureTestOpeningHours(db.pool);
  Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:db.connectionString,
    CHATWOOT_HMAC_SECRET:'test',ADMIN_AUTH_TOKEN:'test',ROUTING_GEO:'false',PICKUP_TO_PARTNER:'false',
    WHOLESALE_UNIFIED_STOCK:'true',WHOLESALE_MATRIZ_DECREMENT:'true',WHOLESALE_MATRIZ_OVERSELL_GUARD:'true',
    WHOLESALE_MATRIZ_RETAIL_COST:'true',PARTNER_STOCK_CONFIRMATION:'false',BOT_OUTBOX:'true'});
  vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Chamada externa bloqueada no teste local');}));
  execute=(await import('../../src/atendente-v2/tools.js')).executeTool;
  owner=(await db.pool.query("INSERT INTO network.partner_people(environment,username,password_hash) VALUES('test','dono-ficticio','fixture') RETURNING id")).rows[0].id;
  await db.pool.query(`INSERT INTO network.matriz_collaborators(environment,person_id,display_name,job,panel_role,job_title,work_area)
    VALUES('test',$1,'Dono de teste','colaborador','owner','Dono','administrative')`,[owner]);
  unit=(await db.pool.query(`INSERT INTO core.units(environment,slug,name) VALUES('test','main','Matriz')
    ON CONFLICT(environment,slug) DO UPDATE SET is_active=true RETURNING id`)).rows[0].id;
  product=(await db.pool.query(`INSERT INTO commerce.products(environment,product_code,product_name,product_type,brand,tire_condition)
    VALUES('test','AVAL-QA','Pneu 110/70-13 de teste','tire','QA','meia_vida') RETURNING id`)).rows[0].id;
  await db.pool.query("INSERT INTO commerce.tire_specs(environment,product_id,tire_size) VALUES('test',$1,'110/70-13')",[product]);
  await db.pool.query("INSERT INTO commerce.matriz_product_prices(environment,product_id,price_amount) VALUES('test',$1,110)",[product]);
  await db.pool.query(`INSERT INTO commerce.wholesale_stock(environment,measure,brand,tire_condition,quantity_on_hand,unit_cost)
    VALUES('test','110/70-13','QA','meia_vida',100,50)`);
},240000);
afterAll(async()=>{vi.unstubAllGlobals();if(db)await stopPostgres(db);});

async function mensagem(conversationId:string, text:string) {
  const r=await db.pool.query(`INSERT INTO core.messages(environment,conversation_id,chatwoot_conversation_id,chatwoot_message_id,
    sender_type,message_type,is_private,content,sent_at)
    SELECT 'test',id,chatwoot_conversation_id,$2,'contact',0,false,$3,clock_timestamp() FROM core.conversations WHERE id=$1 RETURNING id`,
  [conversationId,++seq,text]);
  return r.rows[0].id as string;
}
async function venda():Promise<milly.PedidoConsultaMilly> {
  const ct=(await db.pool.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name,phone_e164)
    VALUES('test',$1,'Rafael Silva','+5521999990456') RETURNING id`,[++seq])).rows[0].id;
  const c=(await db.pool.query(`INSERT INTO core.conversations(environment,chatwoot_conversation_id,chatwoot_account_id,contact_id,current_status,started_at)
    VALUES('test',$1,1,$2,'open',now()) RETURNING id`,[++seq,ct])).rows[0].id;
  return {environment:'test',conversationId:c,triggerMessageId:await mensagem(c,'Faz R$ 80 por um para retirada no Pix?'),
    unitId:unit,productId:product,quantity:1,paymentMethod:'pix',fulfillmentMode:'pickup',offeredTotalCents:8000,
    catalogUnitCents:11000,freightCents:0,destinationKey:null};
}
const ligar=(v:boolean)=>milly.definirConsultaMilly(db.pool,'test',v,owner);
const aprovar=(id:string)=>milly.registrarParecerMilly(db.pool,'test',id,{decisao:'aceitar',totalCentavos:8000,personId:owner});
async function checkout(v:milly.PedidoConsultaMilly, trigger:string, preco:number, extra:Record<string,unknown>={}) {
  const client=await db.pool.connect();
  try {
    await client.query('BEGIN');
    const raw=await atOpenStoreTime(()=>execute(client,'test',v.conversationId,'criar_pedido',{
      itens:[{product_id:product,quantidade:1,preco_unitario:preco}],modalidade:'pickup',
      nome_cliente:'Rafael Silva',forma_pagamento:'pix',valor_frete:0,...extra
    },undefined,{triggerMessageId:trigger}),'test');
    await client.query('COMMIT');return JSON.parse(raw);
  } catch(e){await client.query('ROLLBACK');throw e;} finally {client.release();}
}
async function ack(id:string, v:milly.PedidoConsultaMilly, mensagemEnviada:string) {
  return (await db.pool.query(`INSERT INTO ops.outbound_messages(environment,conversation_id,trigger_message_id,
    chatwoot_conversation_id,provider_message_id,kind,body,body_sha256,status,sent_at,milly_offer_id)
    SELECT 'test',id,$2,chatwoot_conversation_id,$3,'agent_text',$4,$5,'sent_api_ack',clock_timestamp(),$6
    FROM core.conversations WHERE id=$1 RETURNING id`,[v.conversationId,v.triggerMessageId,++seq,mensagemEnviada,
    createHash('sha256').update(mensagemEnviada).digest('hex'),id])).rows[0].id as string;
}
it('desligado conserva a tabela; pausa invalida a resposta tardia mesmo depois de religar',async()=>{
  expect(await milly.lerConsultaMilly(db.pool,'test')).toBe(false);
  const v=await venda();
  expect(await milly.solicitarConsultaMilly(db.pool,v)).toBeNull();
  expect((await checkout(v,v.triggerMessageId,80)).ok).toBeFalsy();
  expect(await checkout(v,v.triggerMessageId,110)).toMatchObject({ok:true,total:'110.00'});
  await ligar(true);
  const pendente=await venda(),q=await milly.solicitarConsultaMilly(db.pool,pendente);
  expect(q?.criada).toBe(true);
  expect(await milly.solicitarConsultaMilly(db.pool,pendente)).toEqual({id:q!.id,criada:false});
  await ligar(false);await ligar(true);
  expect(await aprovar(q!.id)).toBe(false);
  expect((await milly.lerResultadoConsultaMilly(db.pool,'test',q!.id)).status).toBe('cancelled');
  expect(await milly.lerPedidoConsultaMilly(db.pool,'prod',q!.id)).toBeNull();
});
it('preço privado ainda não fecha; publicação confirmada honra 80 após pausa, uma única vez e somente no Pix',async()=>{
  await ligar(true);
  const v=await venda(),q=(await milly.solicitarConsultaMilly(db.pool,v))!;
  expect(await aprovar(q.id)).toBe(true);
  expect(await milly.buscarOfertaCheckoutMilly(db.pool,'test',v.conversationId)).toBeNull();
  expect((await checkout(v,v.triggerMessageId,80)).ok).toBeFalsy();
  expect(await milly.reservarEnvioOfertaMilly(db.pool,'test',q.id,v.conversationId,v.triggerMessageId,body)).toBe(true);
  // Chatwoot confirmou o envio, mas o processo caiu antes de registrar a publicação.
  await ack(q.id,v,body);
  await ligar(false);
  const publicada=await milly.buscarOfertaCheckoutMilly(db.pool,'test',v.conversationId);
  expect(publicada).toMatchObject({id:q.id,approvedTotalCents:8000});
  const confirmado=await mensagem(v.conversationId,'Fechado, um pneu por R$ 80 na retirada, pago no Pix.');
  expect((await checkout(v,confirmado,80,{forma_pagamento:'cartao'})).ok).toBeFalsy();
  const pedido=await checkout(v,confirmado,80);
  expect(pedido).toMatchObject({ok:true,total:'80.00'});
  expect(await checkout(v,confirmado,80)).toMatchObject({ok:true,repetido:true,order_number:pedido.order_number});
  const gravado=(await db.pool.query(`SELECT o.id,o.total_amount,i.unit_price,r.state,r.order_id
    FROM commerce.orders o JOIN commerce.order_items i ON i.order_id=o.id
    JOIN ops.milly_consultas r ON r.order_id=o.id WHERE r.id=$1`,[q.id])).rows;
  expect(gravado).toEqual([{id:expect.any(String),total_amount:'80.00',unit_price:'80.00',state:'consumed',order_id:expect.any(String)}]);
  expect(await milly.pedidoComAvalMilly(db.pool,'test',gravado[0].id)).toBe(true);
  expect(await milly.buscarOfertaCheckoutMilly(db.pool,'test',v.conversationId)).toBeNull();
});
it('o esquecimento do contato apaga a consulta privada e impede nova consulta pelo mesmo atendimento',async()=>{
  await ligar(true);
  const v=await venda();
  const ativa=await milly.solicitarConsultaMilly(db.pool,v);
  expect(ativa?.id).toBeTruthy();
  await db.pool.query(`SELECT ops.anonymize_contact(contact_id,'cliente','teste')
    FROM core.conversations WHERE environment='test' AND id=$1`,[v.conversationId]);
  expect((await db.pool.query('SELECT id FROM ops.milly_consultas WHERE id=$1',[ativa!.id])).rows).toEqual([]);
  expect(await milly.solicitarConsultaMilly(db.pool,v)).toBeNull();
});
it('uma pausa anterior ao envio e uma confirmação com corpo diferente não criam preço público',async()=>{
  await ligar(true);const v=await venda(),q=(await milly.solicitarConsultaMilly(db.pool,v))!;
  expect(await aprovar(q.id)).toBe(true);await ligar(false);
  expect(await milly.reservarEnvioOfertaMilly(db.pool,'test',q.id,v.conversationId,v.triggerMessageId,body)).toBe(false);
  await ligar(true);const outro=await venda(),q2=(await milly.solicitarConsultaMilly(db.pool,outro))!;
  await aprovar(q2.id);
  await milly.reservarEnvioOfertaMilly(db.pool,'test',q2.id,outro.conversationId,outro.triggerMessageId,body);
  await ack(q2.id,outro,'O preço é o de tabela.');
  expect(await milly.buscarOfertaCheckoutMilly(db.pool,'test',outro.conversationId)).toBeNull();
});
it('recupera uma oferta do eco público exato quando o ACK HTTP se perdeu',async()=>{
  await ligar(true);
  const v=await venda(),q=(await milly.solicitarConsultaMilly(db.pool,v))!;
  await aprovar(q.id);
  await milly.reservarEnvioOfertaMilly(db.pool,'test',q.id,v.conversationId,v.triggerMessageId,body);
  const turn=(await db.pool.query(`INSERT INTO agent.turns(environment,conversation_id,trigger_message_id,agent_version,
    context_hash,status,say_text) VALUES('test',$1,$2,'v2','fixture','generated',$3) RETURNING id`,[v.conversationId,v.triggerMessageId,body])).rows[0].id;
  const outgoing=async (privateNote:boolean,echo:string,text:string)=>db.pool.query(`INSERT INTO core.messages(environment,conversation_id,
    chatwoot_conversation_id,chatwoot_message_id,sender_type,message_type,is_private,content,sent_at,content_attributes)
    SELECT 'test',id,chatwoot_conversation_id,$2,'user',1,$3,$4,clock_timestamp(),jsonb_build_object('farejador_echo_id',$5::text)
    FROM core.conversations WHERE id=$1`,[v.conversationId,++seq,privateNote,text,echo]);
  await ligar(false);
  await outgoing(true,'turn:'+turn,body);
  await outgoing(false,'turn:'+turn,'Outra mensagem');
  await outgoing(false,'turn:outro',body);
  expect(await milly.buscarOfertaCheckoutMilly(db.pool,'test',v.conversationId)).toBeNull();
  await outgoing(false,'turn:'+turn,body);
  expect(await milly.buscarOfertaCheckoutMilly(db.pool,'test',v.conversationId)).toMatchObject({id:q.id,publishedProviderId:String(seq)});
});
it('reaproveita recusa idêntica e reavalia se a proposta mudar; prazo vencido não autoriza',async()=>{
  await ligar(true);
  const v=await venda();
  const duplicadas=await Promise.all([milly.solicitarConsultaMilly(db.pool,v),milly.solicitarConsultaMilly(db.pool,v)]);
  const id=duplicadas[0]!.id;
  expect(duplicadas[1]!.id).toBe(id);expect(duplicadas.filter(x=>x?.criada)).toHaveLength(1);
  expect(await milly.registrarParecerMilly(db.pool,'test',id,{decisao:'manter',orientacao:'seguir_tabela',personId:owner})).toBe(true);
  expect(await milly.lerResultadoConsultaMilly(db.pool,'test',id)).toMatchObject({decisao:'manter',orientacao:'seguir_tabela'});
  const insistiu=await mensagem(v.conversationId,'Faço 80 mesmo.');
  expect(await milly.solicitarConsultaMilly(db.pool,{...v,triggerMessageId:insistiu})).toBeNull();
  const nova=(await milly.solicitarConsultaMilly(db.pool,{...v,triggerMessageId:await mensagem(v.conversationId,'E por 95?'),offeredTotalCents:9500}))!;
  expect(nova.criada).toBe(true);
  await db.pool.query("UPDATE ops.milly_consultas SET request_deadline=clock_timestamp()-interval '1 second' WHERE id=$1",[nova.id]);
  expect(await milly.registrarParecerMilly(db.pool,'test',nova.id,{decisao:'aceitar',totalCentavos:9500,personId:owner})).toBe(false);
});

it('oferta vencida e pausa não autorizam cobrar tabela no aceite antigo; nova cotação pública exige aceite posterior',async()=>{
  await ligar(true);
  const v=await venda(),q=(await milly.solicitarConsultaMilly(db.pool,v))!;
  expect(await aprovar(q.id)).toBe(true);
  expect(await milly.reservarEnvioOfertaMilly(db.pool,'test',q.id,v.conversationId,v.triggerMessageId,body)).toBe(true);
  await ack(q.id,v,body); // ACK durável, ainda sem reconciliação do estado sending.
  await db.pool.query("UPDATE ops.outbound_messages SET sent_at=clock_timestamp()-interval '2 minutes' WHERE milly_offer_id=$1",[q.id]);
  await db.pool.query("UPDATE ops.milly_consultas SET valid_until=clock_timestamp()-interval '1 second' WHERE id=$1",[q.id]);
  await ligar(false);
  const antigo=await mensagem(v.conversationId,'Fechado, um pneu por R$ 80 na retirada, pago no Pix.');
  const primeira=await checkout(v,antigo,80);
  expect(await checkout(v,antigo,110)).toEqual(primeira);
  expect(primeira.erro).toBe('oferta_expirada');
  const texto=primeira.texto_para_cliente as string;
  expect(texto.replace(/\s/g,' ')).toMatch(/R\$ 110,00 no total, no Pix/);
  expect((await db.pool.query('SELECT state FROM ops.milly_consultas WHERE id=$1',[q.id])).rows[0].state).toBe('published');
  const saida=(conteudo:string,privada:boolean)=>db.pool.query(`INSERT INTO core.messages(environment,conversation_id,
    chatwoot_conversation_id,chatwoot_message_id,sender_type,message_type,is_private,content,sent_at)
    SELECT 'test',id,chatwoot_conversation_id,$2,'agent_bot',1,$3,$4,clock_timestamp() FROM core.conversations WHERE id=$1`,
    [v.conversationId,++seq,privada,conteudo]);
  await saida(texto,true);
  const simInterno=await mensagem(v.conversationId,'Sim');
  expect((await checkout(v,simInterno,110)).erro).toBe('oferta_expirada');
  await saida(texto,false);
  expect((await checkout(v,simInterno,110)).erro).toBe('oferta_expirada');
  const insistiu=await mensagem(v.conversationId,'Fechado por R$ 80');
  expect((await checkout(v,insistiu,110)).erro).toBe('oferta_expirada');
  expect((await db.pool.query('SELECT id FROM commerce.orders WHERE source_conversation_id=$1',[v.conversationId])).rowCount).toBe(0);
  await saida(texto,false);
  const confirmou=await mensagem(v.conversationId,'Fechado, um pneu por R$ 110 na retirada, pago no Pix.');
  expect(await checkout(v,confirmou,110)).toMatchObject({ok:true,total:'110.00'});
  const pedidos=await db.pool.query('SELECT total_amount FROM commerce.orders WHERE source_conversation_id=$1',[v.conversationId]);
  expect(pedidos.rows).toEqual([{total_amount:'110.00'}]);
});

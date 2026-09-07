import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { startPostgres,stopPostgres,type IntegrationDb } from './helpers/postgres.js';

describe('memória permanente e endereço anterior do cliente',() => {
  let db:IntegrationDb;
  let loadContext:typeof import('../../src/atendente-v2/customer-context.js').loadCustomerContext;
  let resolveAddress:typeof import('../../src/atendente-v2/previous-delivery-address.js').resolveDeliveryAddress;
  let contactId:string,currentConversationId:string;

  beforeAll(async () => {
    Object.assign(process.env,{ NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgres://test',
      CHATWOOT_HMAC_SECRET:'test-secret',ADMIN_AUTH_TOKEN:'test-admin' });
    db=await startPostgres();process.env.DATABASE_URL=db.connectionString;
    ({ loadCustomerContext:loadContext }=await import('../../src/atendente-v2/customer-context.js'));
    ({ resolveDeliveryAddress:resolveAddress }=await import('../../src/atendente-v2/previous-delivery-address.js'));
    contactId=(await db.pool.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name,phone_e164)
      VALUES('test',990201,'Ana Contexto','+5521999900201') RETURNING id`)).rows[0].id;
    currentConversationId=(await db.pool.query(`INSERT INTO core.conversations(environment,chatwoot_conversation_id,
      chatwoot_account_id,contact_id,current_status,started_at) VALUES('test',990202,2,$1,'open',now()) RETURNING id`,[contactId])).rows[0].id;
    const productId=(await db.pool.query(`INSERT INTO commerce.products(environment,product_code,product_name,product_type)
      VALUES('test','CTX-ORDER','Pneu Contexto 90/90-18','tire') RETURNING id`)).rows[0].id;
    const orderId=(await db.pool.query(`INSERT INTO commerce.orders(environment,contact_id,total_amount,status,
      fulfillment_mode,delivery_status,delivery_address,delivered_at)
      VALUES('test',$1,250,'confirmed','delivery','delivered','Rua Histórica, 77, Centro',now()-interval '40 days') RETURNING id`,[contactId])).rows[0].id;
    await db.pool.query(`INSERT INTO commerce.order_items(environment,order_id,product_id,quantity,unit_price)
      VALUES('test',$1,$2,1,250)`,[orderId,productId]);
  },180_000);
  afterAll(async()=>{if(db)await stopPostgres(db);});

  it('lembra cadastro e compra antiga sem depender da janela de 11 dias nem expor o endereço',async()=>{
    const context=await loadContext(db.pool as never,currentConversationId);
    expect(context).toContain('Ana');
    expect(context).toContain('Telefone já cadastrado');
    expect(context).toContain('Cliente recorrente: 1 compra(s)');
    expect(context).toContain('90/90-18');
    expect(context).toContain('ENDEREÇO ANTERIOR DISPONÍVEL');
    expect(context).not.toContain('Rua Histórica');
    expect(context).not.toContain('+5521999900201');
  });

  it('recupera endereço antigo quando o GPT sinaliza a resposta contextual na conversa atual',async()=>{
    await db.pool.query(`INSERT INTO core.messages(environment,chatwoot_message_id,conversation_id,
      chatwoot_conversation_id,sender_type,message_type,content,is_private,sent_at) VALUES
      ('test',990203,$1,990202,'agent_bot',1,'Vai ser para o mesmo endereço da última entrega?',false,now()-interval '1 minute'),
      ('test',990204,$1,990202,'contact',0,'Demorô, manda naquele de sempre então',false,now())`,[currentConversationId]);
    await expect(resolveAddress(db.pool as never,'test',currentConversationId,contactId,{ usePrevious:true }))
      .resolves.toEqual({ ok:true,address:'Rua Histórica, 77, Centro',source:'previous_delivery' });
  });

  it('não cruza o endereço com outro contato',async()=>{
    const other=(await db.pool.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name)
      VALUES('test',990205,'Outro cliente') RETURNING id`)).rows[0].id;
    await expect(resolveAddress(db.pool as never,'test',currentConversationId,other,{ usePrevious:true }))
      .resolves.toEqual({ ok:false,code:'endereco_anterior_indisponivel' });
  });
});

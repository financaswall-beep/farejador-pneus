import {beforeAll,afterAll,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {startPostgres,stopPostgres,type IntegrationDb} from './helpers/postgres.js';
describe('cadastro comercial — PostgreSQL descartável',()=>{
  let db:IntegrationDb;
  let service:typeof import('../../src/admin/painel/customer-registry.js');
  let schema:typeof import('../../src/admin/painel/customer-registry-schema.js');
  let contactId:string;
  beforeAll(async()=>{
    db=await startPostgres();
    Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:db.connectionString,
      CHATWOOT_HMAC_SECRET:'test-secret',ADMIN_AUTH_TOKEN:'test-admin',MATRIZ_CUSTOMER_REGISTRY:'true'});
    vi.resetModules();
    service=await import('../../src/admin/painel/customer-registry.js');
    schema=await import('../../src/admin/painel/customer-registry-schema.js');
    contactId=(await db.pool.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name,phone_e164)
      VALUES('test',920011,'Nome do Chatwoot','2548825') RETURNING id`)).rows[0].id;
  });
  afterAll(async()=>{if(db) await stopPostgres(db);});
  const input=(patch:object={})=>schema.registryFields.parse({name:'Roberto Lima',commercial_profile:'varejo',
    phone:'',email:'',document_number:'',postal_code:'',street:'Rua Um',number:'S/N',complement:'',neighborhood:'Centro',city:'Niterói',state:'RJ',...patch});
  it('revisa o contato sem mudar core, pedidos, movimentos ou caixa',async()=>{
    const before=(await db.pool.query(`SELECT (SELECT count(*) FROM commerce.orders) orders,
      (SELECT count(*) FROM commerce.wholesale_orders) wholesale,
      (SELECT count(*) FROM commerce.wholesale_stock_movements) movements,
      (SELECT count(*) FROM finance.matriz_ledger_transactions) ledger`)).rows[0];
    const revised=await service.updateCustomerRegistry('test','chatwoot',contactId,input({name:'Borracharia Exemplo',
      commercial_profile:'atacado',phone:'(21) 2548-8825'}),0,'owner-test',db.pool);
    expect(revised).toMatchObject({version:1,phone:'+552125488825',commercial_profile:'atacado'});
    expect((await db.pool.query(`SELECT name,phone_e164 FROM core.contacts WHERE id=$1`,[contactId])).rows[0])
      .toEqual({name:'Nome do Chatwoot',phone_e164:'2548825'});
    expect((await db.pool.query(`SELECT (SELECT count(*) FROM commerce.orders) orders,
      (SELECT count(*) FROM commerce.wholesale_orders) wholesale,
      (SELECT count(*) FROM commerce.wholesale_stock_movements) movements,
      (SELECT count(*) FROM finance.matriz_ledger_transactions) ledger`)).rows[0]).toEqual(before);
    expect(await service.readRegistryEntry('prod','chatwoot',contactId,db.pool)).toBe(null);
    await expect(service.updateCustomerRegistry('prod','chatwoot',contactId,input(),0,'owner-test',db.pool)).rejects.toThrow('customer_not_found');
    const {getCustomerDetail}=await import('../../src/admin/painel/customer-detail.js');
    expect((await getCustomerDetail('test','chatwoot',contactId,{},db.pool))?.customer)
      .toMatchObject({name:'Borracharia Exemplo',phone:'+552125488825',registry:{commercial_profile:'atacado'}});
  });
  it('rejeita gravação concorrente e registra somente a versão vencedora',async()=>{
    const outcomes=await Promise.allSettled([
      service.updateCustomerRegistry('test','chatwoot',contactId,input({name:'Revisão A'}),1,'owner-a',db.pool),
      service.updateCustomerRegistry('test','chatwoot',contactId,input({name:'Revisão B'}),1,'owner-b',db.pool),
    ]);
    expect(outcomes.filter(row=>row.status==='fulfilled')).toHaveLength(1);
    expect(outcomes.filter(row=>row.status==='rejected')).toHaveLength(1);
    expect((await db.pool.query(`SELECT version FROM commerce.customer_registry_audit
      WHERE source_id=$1 ORDER BY version`,[contactId])).rows.map(row=>row.version)).toEqual([1,2]);
  });
  it('cria varejo/atacado sem venda e não duplica em reenvio',async()=>{
    for(const profile of ['varejo','atacado']){
      const key=randomUUID(),data=input({name:`Oficina ${profile}`,commercial_profile:profile});
      const [first,second]=await Promise.all([
        service.createCustomerRegistry('test',data,key,'owner',db.pool),
        service.createCustomerRegistry('test',data,key,'owner',db.pool),
      ]);
      expect(first).toEqual(second);expect(first.source).toBe(profile==='atacado'?'atacado':'balcao');
      await expect(service.createCustomerRegistry('test',input({name:'Outro nome'}),key,'owner',db.pool)).rejects.toThrow('idempotency_conflict');
      const {getClientesPainel}=await import('../../src/admin/painel/queries-clientes.js');
      const list=await getClientesPainel('test',db.pool);
      expect(list.rows.find(row=>row.source_id===first.source_id)).toMatchObject({name:`Oficina ${profile}`,purchases:0,commercial_profile:profile});
    }
  });
  it('bloqueia duplicidade conhecida de telefone entre fontes',async()=>{
    await service.createCustomerRegistry('test',input({phone:'(21) 99999-4321'}),randomUUID(),'owner',db.pool);
    await expect(service.createCustomerRegistry('test',input({phone:'+5521999994321',commercial_profile:'atacado'}),randomUUID(),'owner',db.pool))
      .rejects.toThrow('customer_phone_exists');
  });
  it('não concede cadastro, documentos ou auditoria ao parceiro',async()=>{
    for(const table of ['customer_registry','customer_registry_audit','customer_registry_requests']) {
      const found=await db.pool.query(`SELECT has_table_privilege('farejador_partner_app',$1,'SELECT') allowed`,[`commerce.${table}`]);
      expect(found.rows[0].allowed).toBe(false);
    }
  });
  it('mantém revisões no inventário de privacidade mesmo com a interface desligada',async()=>{
    const identity=(await db.pool.query(`INSERT INTO commerce.customer_identities(environment,entity_type)
      VALUES('test','person') RETURNING id`)).rows[0].id;
    await db.pool.query(`INSERT INTO commerce.customer_identity_links(environment,identity_id,source_type,source_id,owner_scope,linked_by,link_reason)
      VALUES('test',$1,'chatwoot_contact',$2,'matrix','owner','fixture')`,[identity,contactId]);
    const {env}=await import('../../src/shared/config/env.js');
    env.MATRIZ_CUSTOMER_REGISTRY=false;
    try {
      expect(await service.customerRegistryForIdentity('test',identity,db.pool)).toHaveLength(1);
      expect(await service.customerRegistryForIdentity('prod',identity,db.pool)).toHaveLength(0);
    } finally {env.MATRIZ_CUSTOMER_REGISTRY=true;}
  });
});

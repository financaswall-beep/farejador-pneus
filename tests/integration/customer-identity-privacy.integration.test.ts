import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { buildRestrictedConnectionString, startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('Etapa 9 - identidade de cliente e privacidade', () => {
  let db: IntegrationDb;
  let backfill: typeof import('../../src/admin/painel/customer-identity-service.js').backfillCustomerIdentities;
  let decide: typeof import('../../src/admin/painel/customer-identity-service.js').decideIdentityCandidate;
  let split: typeof import('../../src/admin/painel/customer-identity-split.js').splitCustomerIdentity;
  let listV2: typeof import('../../src/admin/painel/queries-clientes-v2.js').getClientesPainelV2;
  let streamCsv: typeof import('../../src/admin/painel/customer-export.js').streamCustomerCsv;
  let inventory: typeof import('../../src/admin/painel/customer-privacy-inventory.js').inventoryCustomerPrivacy;
  let createPrivacy: typeof import('../../src/admin/painel/customer-privacy-service.js').createPrivacyRequest;
  let verifyPrivacy: typeof import('../../src/admin/painel/customer-privacy-service.js').verifyPrivacyRequest;
  let previewPrivacy: typeof import('../../src/admin/painel/customer-privacy-service.js').previewPrivacyRequest;
  let approvePrivacy: typeof import('../../src/admin/painel/customer-privacy-service.js').approvePrivacyRequest;
  let executePrivacy: typeof import('../../src/admin/painel/customer-privacy-service.js').executePrivacyRequest;
  let chatContactId: string;
  let testContactId: string;

  beforeAll(async () => {
    Object.assign(process.env,{ NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgres://test',
      CHATWOOT_HMAC_SECRET:'test-secret',ADMIN_AUTH_TOKEN:'emergency-token' });
    db = await startPostgres();
    ({ backfillCustomerIdentities:backfill,decideIdentityCandidate:decide } =
      await import('../../src/admin/painel/customer-identity-service.js'));
    ({ splitCustomerIdentity:split } = await import('../../src/admin/painel/customer-identity-split.js'));
    ({ getClientesPainelV2:listV2 } = await import('../../src/admin/painel/queries-clientes-v2.js'));
    ({ streamCustomerCsv:streamCsv } = await import('../../src/admin/painel/customer-export.js'));
    ({ inventoryCustomerPrivacy:inventory } = await import('../../src/admin/painel/customer-privacy-inventory.js'));
    ({ createPrivacyRequest:createPrivacy,verifyPrivacyRequest:verifyPrivacy,
      previewPrivacyRequest:previewPrivacy,approvePrivacyRequest:approvePrivacy,
      executePrivacyRequest:executePrivacy } = await import('../../src/admin/painel/customer-privacy-service.js'));

    await db.pool.query(`INSERT INTO core.units(environment,slug,name) VALUES
      ('test','identity-partner','Parceiro Teste') ON CONFLICT DO NOTHING`);
    const unit = await db.pool.query<{ id:string }>(
      `SELECT id FROM core.units WHERE environment='test' AND slug='identity-partner'`);
    const partner = await db.pool.query<{ id:string }>(
      `INSERT INTO network.partners(environment,legal_name,trade_name,whatsapp_phone,status)
       VALUES('test','Borracharia Estrutural Ltda','Borracharia Estrutural','+5521888888888','active') RETURNING id`);
    await db.pool.query(
      `INSERT INTO network.partner_units(environment,partner_id,unit_id,slug,display_name,status)
       VALUES('test',$1,$2,'identity-partner','Parceiro Teste','active')`,[partner.rows[0]!.id,unit.rows[0]!.id]);
    const prodContact = await db.pool.query<{ id:string }>(
      `INSERT INTO core.contacts(environment,chatwoot_contact_id,name,phone_e164,email)
       VALUES('test',910001,'Maria Integral','+5521999991111','maria@example.test') RETURNING id`);
    chatContactId = prodContact.rows[0]!.id;
    const otherEnv = await db.pool.query<{ id:string }>(
      `INSERT INTO core.contacts(environment,chatwoot_contact_id,name,phone_e164)
       VALUES('prod',910002,'Maria Outro Ambiente','+5521999991111') RETURNING id`);
    testContactId = otherEnv.rows[0]!.id;
    await db.pool.query(
      `INSERT INTO commerce.customers(environment,name,phone_e164,source)
       VALUES('test','Maria Balcao','+5521999991111','walkin')`);
    await db.pool.query(
      `INSERT INTO commerce.partner_customers(environment,unit_id,name,phone,cpf,is_vip)
       VALUES('test',$1,'Maria Parceiro','+5521999991111','12345678900',true)`,[unit.rows[0]!.id]);
    await db.pool.query(
      `INSERT INTO commerce.wholesale_customers(environment,partner_id,name,phone)
       VALUES('test',$1,'Borracharia Estrutural','+5521888888888')`,[partner.rows[0]!.id]);
  },180_000);

  afterAll(async () => { if (db) await stopPostgres(db); });

  it('cria uma identidade por fonte, une apenas FK estrutural e deixa telefone como candidato', async () => {
    const result = await backfill('test','owner-test',db.pool);
    expect(result.sources).toBe(5);
    expect(result.identities_created).toBe(5);
    expect(result.structural_merges).toBe(1);
    expect(result.candidates_created).toBe(3);

    const phoneLinks = await db.pool.query<{ identity_id:string }>(
      `SELECT DISTINCT l.identity_id FROM commerce.customer_identity_links l
       WHERE l.environment='test' AND l.source_type IN ('chatwoot_contact','walkin_customer','partner_customer')`);
    expect(phoneLinks.rowCount).toBe(3);
    const replay = await backfill('test','owner-test',db.pool);
    expect(replay.identities_created).toBe(0);
    expect(replay.candidates_created).toBe(0);
  });

  it('aprova sob lock, registra auditoria e permite split idempotente', async () => {
    const candidates = await db.pool.query<{ id:string;left_link_id:string;right_link_id:string }>(
      `SELECT id,left_link_id,right_link_id FROM commerce.customer_identity_candidates
       WHERE environment='test' AND status='pending' ORDER BY id LIMIT 1`);
    const candidate = candidates.rows[0]!;
    const approved = await decide({ environment:'test',candidateId:candidate.id,decision:'approve',
      actor:'owner-test',reason:'confirmacao humana do cadastro' },db.pool);
    expect(approved.status).toBe('approved');
    expect((await decide({ environment:'test',candidateId:candidate.id,decision:'approve',
      actor:'owner-test',reason:'confirmacao humana do cadastro' },db.pool)).status).toBe('approved');
    const mergedLinks = await db.pool.query<{ identity_id:string }>(
      `SELECT DISTINCT identity_id FROM commerce.customer_identity_links WHERE id=ANY($1::uuid[])`,
      [[candidate.left_link_id,candidate.right_link_id]]);
    expect(mergedLinks.rowCount).toBe(1);
    const identityId = mergedLinks.rows[0]!.identity_id;
    const allLinks = await db.pool.query<{ id:string }>(
      `SELECT id FROM commerce.customer_identity_links WHERE identity_id=$1 AND ended_at IS NULL ORDER BY id`,[identityId]);
    expect(allLinks.rows.length).toBeGreaterThan(1);
    const splitResult = await split({ environment:'test',identityId,linkIds:[allLinks.rows[0]!.id],
      actor:'owner-test',reason:'fontes representam pessoas diferentes',idempotencyKey:'split-integration-001' },db.pool);
    expect(splitResult.moved_links).toBe(1);
    const replay = await split({ environment:'test',identityId,linkIds:[allLinks.rows[0]!.id],
      actor:'owner-test',reason:'fontes representam pessoas diferentes',idempotencyKey:'split-integration-001' },db.pool);
    expect(replay.replayed).toBe(true);
  });

  it('bloqueia cruzamento de ambiente, mutacao do ledger e acesso do parceiro', async () => {
    const identity = await db.pool.query<{ id:string }>(
      `INSERT INTO commerce.customer_identities(environment) VALUES('test') RETURNING id`);
    await expect(db.pool.query(
      `INSERT INTO commerce.customer_identity_links(environment,identity_id,source_type,source_id,
        owner_scope,linked_by,link_reason) VALUES('test',$1,'chatwoot_contact',$2,'matrix','test','test')`,
      [identity.rows[0]!.id,testContactId])).rejects.toThrow(/environment_mismatch/);
    const request = await db.pool.query<{ id:string }>(
      `INSERT INTO ops.privacy_requests(environment,identity_id,request_type,idempotency_key,
       request_fingerprint,created_by) VALUES('test',$1,'portability','ledger-test-001','hash','owner') RETURNING id`,
      [identity.rows[0]!.id]);
    const event = await db.pool.query<{ id:string }>(
      `INSERT INTO ops.privacy_request_events(environment,privacy_request_id,event_type,actor_label)
       VALUES('test',$1,'created','owner') RETURNING id`,[request.rows[0]!.id]);
    await expect(db.pool.query(`UPDATE ops.privacy_request_events SET event_type='changed' WHERE id=$1`,
      [event.rows[0]!.id])).rejects.toThrow(/append_only/);
    const restricted = new Pool({ connectionString:buildRestrictedConnectionString(db.connectionString) });
    try { await expect(restricted.query(`SELECT count(*) FROM commerce.customer_identities`)).rejects.toThrow(/permission denied/); }
    finally { await restricted.end(); }
  });

  it('mostra PII integral ao owner e exporta 1.205 linhas sem teto 500', async () => {
    await db.pool.query(`WITH n AS (SELECT generate_series(1,1205) i)
      INSERT INTO commerce.customers(id,environment,name,phone_e164,source)
      SELECT ('10000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'test',
             CASE WHEN i=1 THEN '=Bulk Cliente 0001' ELSE 'Bulk Cliente '||lpad(i::text,4,'0') END,
             '+55217'||lpad(i::text,7,'0'),'walkin' FROM n`);
    await db.pool.query(`WITH n AS (SELECT generate_series(1,1205) i)
      INSERT INTO commerce.customer_identities(id,environment,entity_type)
      SELECT ('20000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'test','person' FROM n`);
    await db.pool.query(`WITH n AS (SELECT generate_series(1,1205) i)
      INSERT INTO commerce.customer_identity_links(environment,identity_id,source_type,source_id,
      owner_scope,linked_by,link_reason)
      SELECT 'test',('20000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'walkin_customer',
        ('10000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'matrix','fixture','bulk_export' FROM n`);
    const page = await listV2({ filter:'Maria Integral',limit:20 },'test',db.pool);
    expect(page.rows.some((row) => row.name==='Maria Integral' && row.phone==='+5521999991111')).toBe(true);
    let csv = '';
    for await (const chunk of streamCsv('test','Bulk Cliente',db.pool)) csv += chunk;
    const lines = csv.trim().split(/\r?\n/);
    expect(lines).toHaveLength(1206);
    expect(csv).toContain('Bulk Cliente 1205');
    expect(csv).toContain("'=Bulk Cliente 0001");
    expect(csv).not.toContain(chatContactId);
  },120_000);

  it('inventaria bot/raw/anexos/fanout/pesquisa e bloqueia anonimização destrutiva', async () => {
    const chatIdentity = await db.pool.query<{ identity_id:string }>(
      `SELECT identity_id FROM commerce.customer_identity_links WHERE environment='test'
        AND source_type='chatwoot_contact' AND source_id=$1 AND ended_at IS NULL`,[chatContactId]);
    const identityId = chatIdentity.rows[0]!.identity_id;
    const conversation = await db.pool.query<{ id:string }>(
      `INSERT INTO core.conversations(environment,chatwoot_conversation_id,chatwoot_account_id,contact_id,
        current_status,started_at) VALUES('test',920001,1,$1,'open','2026-05-10T10:00:00Z') RETURNING id`,[chatContactId]);
    const message = await db.pool.query<{ id:string }>(
      `INSERT INTO core.messages(environment,chatwoot_message_id,conversation_id,chatwoot_conversation_id,
        sender_type,message_type,content,is_private,sent_at)
       VALUES('test',930001,$1,920001,'contact',0,'Meu nome é Maria e quero o pneu',false,'2026-05-10T10:01:00Z') RETURNING id`,
      [conversation.rows[0]!.id]);
    await db.pool.query(
      `INSERT INTO core.message_attachments(environment,chatwoot_attachment_id,message_id,conversation_id,
       file_type,data_url,coordinates_lat,coordinates_lng) VALUES('test',940001,$1,$2,'location',
       'https://chatwoot.example.test/private/940001',-22.9,-43.2)`,[message.rows[0]!.id,conversation.rows[0]!.id]);
    const turn = await db.pool.query<{ id:string }>(
      `INSERT INTO agent.turns(environment,conversation_id,trigger_message_id,agent_version,context_hash,
       say_text,actions,status,blocked_say_text,blocked_actions,blocked_payload)
       VALUES('test',$1,$2,'v-test','hash','Olá Maria','[{"customer_name":"Maria"}]','blocked',
       'Maria, confirme seu endereço','[{"phone":"+5521999991111"}]','{"reason":"privacy fixture"}') RETURNING id`,
      [conversation.rows[0]!.id,message.rows[0]!.id]);
    await db.pool.query(
      `INSERT INTO ops.outbound_messages(environment,conversation_id,turn_id,chatwoot_conversation_id,
       body,body_sha256,status) VALUES('test',$1,$2,920001,'Olá Maria','body-hash','pending')`,
      [conversation.rows[0]!.id,turn.rows[0]!.id]);
    const fact = await db.pool.query<{ id:string }>(
      `INSERT INTO analytics.conversation_facts(environment,conversation_id,fact_key,fact_value,observed_at,
       message_id,truth_type,source,extractor_version)
       VALUES('test',$1,'bairro_consultado','"Centro"','2026-05-10T10:01:00Z',$2,'observed','fixture','v1') RETURNING id`,
      [conversation.rows[0]!.id,message.rows[0]!.id]);
    await db.pool.query(
      `INSERT INTO analytics.fact_evidence(environment,fact_id,from_message_id,evidence_text,evidence_type,extractor_version)
       VALUES('test',$1,$2,'Meu nome é Maria','literal','v1')`,[fact.rows[0]!.id,message.rows[0]!.id]);
    await db.pool.query(
      `INSERT INTO analytics.linguistic_hints(environment,conversation_id,message_id,hint_type,matched_text,
       truth_type,source,extractor_version) VALUES('test',$1,$2,'urgency_marker','urgente','observed','fixture','v1')`,
      [conversation.rows[0]!.id,message.rows[0]!.id]);
    await db.pool.query(
      `INSERT INTO raw.raw_events(environment,chatwoot_delivery_id,chatwoot_signature,received_at,event_type,payload)
       VALUES('test','privacy-raw-001','signature','2026-05-10T10:02:00Z','message_created',
       '{"conversation":{"id":920001},"content":"Meu nome é Maria"}')`);

    const dryRun = await inventory('test',identityId,'anonymization',db.pool);
    expect(dryRun.items.find((item) => item.surface==='agent.turns')?.count).toBe(1);
    expect(dryRun.items.find((item) => item.surface==='raw.raw_events')?.disposition).toBe('pending');
    expect(dryRun.items.find((item) => item.surface==='core_message_attachments')?.count).toBe(1);

    const anon = await createPrivacy({ environment:'test',identityId,requestType:'anonymization',
      idempotencyKey:'privacy-anon-001',actor:'owner-test' },db.pool);
    await verifyPrivacy({ environment:'test',requestId:anon.id,actor:'owner-test',
      registeredChannelConfirmed:true,transactionEvidenceConfirmed:true },db.pool);
    await previewPrivacy('test',anon.id,'owner-test',db.pool);
    await approvePrivacy('test',anon.id,'owner-test','solicitação verificada manualmente',db.pool);
    await expect(executePrivacy('test',anon.id,'owner-test','QUALQUER COISA',db.pool))
      .rejects.toThrow('anonymization_execution_disabled');
    const sourceAfter = await db.pool.query<{ name:string }>(`SELECT name FROM core.contacts WHERE id=$1`,[chatContactId]);
    expect(sourceAfter.rows[0]!.name).toBe('Maria Integral');

    const portability = await createPrivacy({ environment:'test',identityId,requestType:'portability',
      idempotencyKey:'privacy-portability-001',actor:'owner-test' },db.pool);
    await verifyPrivacy({ environment:'test',requestId:portability.id,actor:'owner-test',
      registeredChannelConfirmed:true,transactionEvidenceConfirmed:true },db.pool);
    await previewPrivacy('test',portability.id,'owner-test',db.pool);
    await approvePrivacy('test',portability.id,'owner-test','portabilidade solicitada e verificada',db.pool);
    const executed = await executePrivacy('test',portability.id,'owner-test','EXECUTAR PORTABILIDADE',db.pool);
    expect(executed.request.status).toBe('partially_completed');
    expect(executed.portability_package.profile_sources.some((source) => source.name==='Maria Integral')).toBe(true);
    expect(executed.portability_package.attachments).toHaveLength(1);
  },120_000);

  it('classifica cópias do parceiro e pesquisa sem apagar os fatos econômicos', async () => {
    const linked = await db.pool.query<{ identity_id:string; source_id:string }>(
      `SELECT identity_id,source_id::text FROM commerce.customer_identity_links
       WHERE environment='test' AND source_type='partner_customer' AND ended_at IS NULL`);
    const partnerCustomerId = linked.rows[0]!.source_id;
    const partnerCustomer = await db.pool.query<{ unit_id:string;phone:string }>(
      `SELECT unit_id,phone FROM commerce.partner_customers WHERE id=$1`,[partnerCustomerId]);
    const partnerConversation = await db.pool.query<{ id:string }>(
      `INSERT INTO commerce.partner_conversations(environment,unit_id,chatwoot_conversation_id,
       customer_name,customer_identifier,status) VALUES('test',$1,950001,'Maria Parceiro',$2,'open') RETURNING id`,
      [partnerCustomer.rows[0]!.unit_id,partnerCustomer.rows[0]!.phone]);
    await db.pool.query(
      `INSERT INTO commerce.partner_messages(environment,unit_id,conversation_id,direction,sender,content,attachments)
       VALUES('test',$1,$2,'inbound','customer','Meu comentário privado','[{"url":"private"}]')`,
      [partnerCustomer.rows[0]!.unit_id,partnerConversation.rows[0]!.id]);
    const order = await db.pool.query<{ id:string }>(
      `INSERT INTO commerce.partner_orders(environment,unit_id,customer_id,customer_name,customer_phone,
       total_amount,status,fulfillment_mode,awaiting_pickup)
       VALUES('test',$1,$2,'Maria Parceiro',$3,99,'confirmed','pickup',false) RETURNING id`,
      [partnerCustomer.rows[0]!.unit_id,partnerCustomerId,partnerCustomer.rows[0]!.phone]);
    await db.pool.query(
      `INSERT INTO commerce.partner_order_items(environment,order_id,item_name,quantity,unit_price)
       VALUES('test',$1,'Pneu com custo pendente',1,99)`,[order.rows[0]!.id]);
    await db.pool.query(
      `INSERT INTO commerce.partner_orders(environment,unit_id,customer_id,customer_name,customer_phone,
       total_amount,status,fulfillment_mode,awaiting_pickup)
       VALUES('test',$1,$2,'Maria Parceiro',$3,900,'cancelled','pickup',false)`,
      [partnerCustomer.rows[0]!.unit_id,partnerCustomerId,partnerCustomer.rows[0]!.phone]);
    await db.pool.query(
      `INSERT INTO commerce.satisfaction_surveys(environment,unit_id,partner_order_id,fulfillment_mode,
       conversation_id,status,rating,comment) VALUES('test',$1,$2,'pickup',950001,'answered',5,'Gostei muito')`,
      [partnerCustomer.rows[0]!.unit_id,order.rows[0]!.id]);
    const dryRun = await inventory('test',linked.rows[0]!.identity_id,'anonymization',db.pool);
    expect(dryRun.items.find((item) => item.surface==='commerce.partner_messages')?.count).toBe(1);
    expect(dryRun.items.find((item) => item.surface==='commerce.satisfaction_surveys')?.disposition).toBe('pending');
    expect(dryRun.items.find((item) => item.surface==='financial_facts.partner_orders')?.disposition).toBe('retained');
    const page = await listV2({ filter:'Maria Parceiro',limit:20 },'test',db.pool);
    const row = page.rows.find((item) => item.id===linked.rows[0]!.identity_id)!;
    expect(row.metrics.purchases).toBe(1);
    expect(row.metrics.total_spent).toBe(99);
    expect(row.metrics.pending_cost_items).toBe(1);
    expect(row.metrics.gross_profit).toBeNull();
  });
});

import { afterAll,beforeAll,describe,it,expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startPostgres,stopPostgres,type IntegrationDb } from './helpers/postgres';
import { createPartnerFixture } from './helpers/partner-fixtures';
let db:IntegrationDb;
beforeAll(async()=>{db=await startPostgres();Object.assign(process.env,{DATABASE_URL:db.connectionString,FAREJADOR_ENV:'test',NODE_ENV:'test',CHATWOOT_HMAC_SECRET:'test-secret',ADMIN_AUTH_TOKEN:'admin-test-token-1234567890',NETWORK_COMMISSION_LEDGER:'true'});},180000);
afterAll(async()=>{if(db){const {pool}=await import('../../src/persistence/db.js');const {partnerPool}=await import('../../src/parceiro/db.js');await Promise.all([pool.end(),partnerPool.end()]);await stopPostgres(db);}});
describe('Relatório da Rede — Postgres real e leitura sem conciliação',()=>{
  it('lê vendas realizadas, frete, itens e percentual congelado; não escreve ao consultar',async()=>{
    const partner=await import('../../src/parceiro/queries.js'),admin=await import('../../src/admin/painel/queries.js');
    const {readPartnerSnapshot}=await import('../../src/admin/painel/partner-report-data.js');
    const {buildPartnerReport}=await import('../../src/admin/painel/queries-partner-report.js');
    const {partnerReportQuery}=await import('../../src/admin/painel/partner-report-filter.js');
    const f=await createPartnerFixture(db.pool,{initialStockQty:20}),idle=await createPartnerFixture(db.pool);
    await db.pool.query('UPDATE network.partners SET commission_percent=7 WHERE id=$1',[f.partnerId]);
    await db.pool.query("UPDATE network.partner_units SET address_city='São Gonçalo',address_neighborhood='Alcântara' WHERE id=$1",[f.partnerUnitId]);
    const input={customer_name:'Cliente fictício',customer_phone:null,items:[{partner_stock_id:f.stockId,quantity:1,unit_price:200}],payment_method:'A receber',payment_status:'receivable' as const,fulfillment_mode:'delivery' as const,delivery_address:'Rua de teste, 1',source_tag:'2w' as const,freight_amount:20};
    const sale=await partner.registerPartnerSale(f.ctx,{...input,idempotency_key:randomUUID()},db.pool);
    const pending=await partner.registerPartnerSale(f.ctx,{...input,idempotency_key:randomUUID()},db.pool);
    await partner.updatePartnerDeliveryStatus(f.ctx,sale.order_id,{delivery_status:'delivered',payment_method:'pix',delivery_courier:'Teste'});
    const pickup=(await db.pool.query<{order_id:string}>(`INSERT INTO commerce.partner_orders(environment,unit_id,total_amount,status,fulfillment_mode,awaiting_pickup)
      VALUES('test',$1,200,'confirmed','pickup',true) RETURNING id AS order_id`,[f.unitId])).rows[0]!;
    await admin.updatePartnerCommercialTerms({partner_id:f.partnerId,commercial_model:'commission',commission_percent:9,monthly_fee:null,actor_label:'teste',idempotency_key:randomUUID()},db.pool);
    const today=(await db.pool.query("SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date::text AS day")).rows[0].day;
    const filter=partnerReportQuery.parse({from:today.slice(0,8)+'01',to:today});
    const count=async()=>{const r=await db.pool.query(`SELECT (SELECT count(*) FROM network.commission_entries)::int AS entries,
      (SELECT count(*) FROM network.commission_entry_events)::int AS events,(SELECT count(*) FROM finance.matriz_commission_reversals)::int AS reversals`);return r.rows[0];};
    const before=await count(),snapshot=await readPartnerSnapshot(filter,'test',db.pool),report=buildPartnerReport(snapshot,filter);
    expect(await count()).toEqual(before);expect(report.sales.map(s=>s.id)).toContain(sale.order_id);expect(report.sales.map(s=>s.id)).not.toContain(pending.order_id);expect(report.sales.map(s=>s.id)).not.toContain(pickup.order_id);
    const row=report.sales.find(s=>s.id===sale.order_id)!;expect(row).toMatchObject({total:220,freight:20,quantity:1,commission:14,channel:'farejador'});expect(row.items[0]).toMatchObject({quantity:1,total:200});
    expect(report.commissions.find(c=>c.order_id===sale.order_id)).toMatchObject({base:200,percent:7,amount:14,status:'open'});
    expect(report.partners.find(p=>p.id===idle.partnerId)?.orders).toBe(0);
    expect(JSON.stringify(report)).not.toMatch(/Cliente fictício|Rua de teste|customer_phone|document_number/);
    expect(buildPartnerReport(snapshot,{...filter,city:'São Gonçalo'}).partners.map(p=>p.id)).toEqual([f.partnerId]);
    const prod=buildPartnerReport(await readPartnerSnapshot(filter,'prod',db.pool),filter);expect(prod.sales).toHaveLength(0);expect(prod.partners.some(p=>p.id===f.partnerId)).toBe(false);
    await admin.settleCommissionEntries({partner_id:f.partnerId,settled_by:'teste',idempotency_key:randomUUID(),reason:'recebido no teste'},db.pool);
    await partner.cancelPartnerSale(f.ctx,sale.order_id,'Cancelamento de teste');
    const after=buildPartnerReport(await readPartnerSnapshot(filter,'test',db.pool),filter);
    expect(after.sales.some(s=>s.id===sale.order_id)).toBe(false);expect(after.summary).toMatchObject({generated:14,received:14,reversed:14,open:0,refund:14});
    expect(after.commissions.find(c=>c.order_id===sale.order_id)).toMatchObject({percent:7,status:'reversed',refund_status:'pending'});
  },60000);
});

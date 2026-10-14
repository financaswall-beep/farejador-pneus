import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { startPostgres, stopPostgres, buildRestrictedConnectionString, type IntegrationDb } from './helpers/postgres.js';
import { createPartnerFixture, type PartnerFixture } from './helpers/partner-fixtures.js';
import type { PartnerContext } from '../../src/parceiro/auth.js';

let db:IntegrationDb, a:PartnerFixture, b:PartnerFixture;
let pools:Pool[]=[];
let simple:typeof import('../../src/parceiro/operation-stock-simple.js');
let partnerDb:typeof import('../../src/parceiro/db.js');
let used:typeof import('../../src/atendente-v2/partner-used-products.js');
let matrix:typeof import('../../src/atendente-v2/matriz-product-search.js');
let fulfillment:typeof import('../../src/atendente-v2/fulfillment.js');
let genericId:string, stockId:string;
const input={tire_size:'90/90-18',vehicle_type:'motorcycle' as const,tire_width_mm:90,tire_aspect_ratio:90,
  tire_rim_diameter:18,brand:null,tire_condition:'meia_vida' as const,quantity_on_hand:5,sale_price:55};
beforeAll(async()=>{
  db=await startPostgres();
  Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:db.connectionString,
    PARTNER_DATABASE_URL:buildRestrictedConnectionString(db.connectionString),CHATWOOT_HMAC_SECRET:'test-only',
    ADMIN_AUTH_TOKEN:'test-only',PARTNER_STOCK_CONFIRMATION:'true',WHOLESALE_UNIFIED_STOCK:'true'});
  vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Sem rede externa neste teste');}));
  simple=await import('../../src/parceiro/operation-stock-simple.js');
  partnerDb=await import('../../src/parceiro/db.js');
  used=await import('../../src/atendente-v2/partner-used-products.js');
  matrix=await import('../../src/atendente-v2/matriz-product-search.js');
  fulfillment=await import('../../src/atendente-v2/fulfillment.js');
  pools=[partnerDb.partnerPool,(await import('../../src/persistence/db.js')).pool];
  a=await createPartnerFixture(db.pool); b=await createPartnerFixture(db.pool);
},180_000);
afterAll(async()=>{vi.unstubAllGlobals();for(const p of pools)await p.end();if(db)await stopPostgres(db);});
const context=(unit:PartnerFixture)=>({...unit.ctx,role:'owner'}) as PartnerContext;

describe('usado sem marca exclusivo do parceiro — banco real descartável',()=>{
  it('a role restrita não cria identidade sem contexto nem grava diretamente no catálogo',async()=>{
    await expect(partnerDb.partnerPool.query("SELECT commerce.ensure_partner_used_product('90/90-18','motorcycle')"))
      .rejects.toThrow('partner_context_required');
    await expect(partnerDb.partnerPool.query("INSERT INTO commerce.products(environment,product_code,product_name,product_type) VALUES('test','intruso','intruso','service')"))
      .rejects.toThrow(/permission denied/i);
  });
  it('cadastra sem marca usando a role restrita, vincula o bot e preserva o estoque com marca',async()=>{
    const before=(await db.pool.query('SELECT * FROM commerce.partner_stock_levels WHERE id=$1',[a.stockId])).rows[0];
    const result=await simple.createSimpleOperationTire(context(a),'Teste local',input); stockId=result.stock_id;
    const stock=(await db.pool.query('SELECT * FROM commerce.partner_stock_levels WHERE id=$1',[stockId])).rows[0];
    genericId=stock.product_id;
    expect(stock).toMatchObject({brand:null,tire_condition:'meia_vida',quantity_on_hand:5,sale_price:'55.00',quantity_reserved:0});
    expect((await db.pool.query('SELECT * FROM commerce.products WHERE id=$1',[genericId])).rows[0])
      .toMatchObject({environment:'test',brand:null,partner_generic:true,tire_condition:'meia_vida'});
    expect((await db.pool.query('SELECT * FROM commerce.partner_stock_levels WHERE id=$1',[a.stockId])).rows[0]).toEqual(before);
    expect((await db.pool.query("SELECT * FROM commerce.products WHERE environment='prod' AND partner_generic")).rows).toHaveLength(0);
  });
  it('não soma estoques ou preços de duas lojas e não permite ler/corrigir estoque alheio',async()=>{
    const second=await simple.createSimpleOperationTire(context(b),'Teste local',{...input,sale_price:99,quantity_on_hand:3});
    expect((await db.pool.query('SELECT product_id FROM commerce.partner_stock_levels WHERE id=$1',[second.stock_id])).rows[0].product_id).toBe(genericId);
    await partnerDb.withPartnerContext(a.partnerUnitId,async client=>{
      expect((await client.query('SELECT id FROM commerce.partner_stock_levels WHERE id=$1',[second.stock_id])).rows).toHaveLength(0);
    });
    const client=await db.pool.connect();try{
      expect(await fulfillment.mapProductToPartnerStock(client,'test',a.unitId,genericId,5)).toMatchObject({partner_stock_id:stockId,unit_price:55});
      expect(await fulfillment.mapProductToPartnerStock(client,'test',b.unitId,genericId,4)).toBeNull();
      expect(await fulfillment.mapProductToPartnerStock(client,'test',b.unitId,genericId,3)).toMatchObject({partner_stock_id:second.stock_id,unit_price:99});
    }finally{client.release();}
  });
  it('duas gravações simultâneas criam só uma linha, sem somar quantidade silenciosamente',async()=>{
    const item={...input,tire_size:'100/90-18',tire_width_mm:100};
    const results=await Promise.allSettled([simple.createSimpleOperationTire(context(a),'Teste',item),simple.createSimpleOperationTire(context(a),'Teste',item)]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:{code:'stock_item_already_exists'}});
    expect((await db.pool.query("SELECT quantity_on_hand FROM commerce.partner_stock_levels WHERE environment='test' AND unit_id=$1 AND tire_size='100/90-18' AND brand IS NULL",[a.unitId])).rows).toEqual([{quantity_on_hand:5}]);
  });
  it('a Matriz continua com variante, preço e saldo próprios, mesmo na mesma medida sem marca',async()=>{
    const id=randomUUID();
    await db.pool.query("INSERT INTO commerce.products(id,environment,product_code,product_name,product_type,tire_condition) VALUES($1,'test',$2,'Usado da Matriz','tire','meia_vida')",[id,'MATRIX-'+id]);
    await db.pool.query("INSERT INTO commerce.tire_specs(environment,product_id,tire_size,vehicle_type) VALUES('test',$1,'90/90-18','motorcycle')",[id]);
    await db.pool.query("INSERT INTO commerce.matriz_product_prices(environment,product_id,price_amount) VALUES('test',$1,75)",[id]);
    await db.pool.query("INSERT INTO commerce.wholesale_stock(environment,measure,brand,tire_condition,quantity_on_hand,unit_cost) VALUES('test','90/90-18','Pirelli','meia_vida',8,20)");
    const client=await db.pool.connect();try{
      const offers=await matrix.buscarProdutoMatriz(client,{environment:'test',medida_pneu:'90/90-18',limit:20,apenas_com_estoque:false});
      expect(offers.map(row=>row.product_id)).not.toContain(genericId);
      expect(offers.find(row=>row.product_id===id)).toMatchObject({total_stock_available:8,price_amount:'75.00'});
      expect(await matrix.verificarEstoqueMatriz(client,{environment:'test',product_id:genericId})).toBeNull();
      const candidates=await used.partnerUsedProducts(client,{environment:'test',medida_pneu:'90/90-18',marca:'Pirelli',limit:20,apenas_com_estoque:false});
      expect(candidates).toEqual([expect.objectContaining({product_id:genericId,brand:null,requested_brand:'Pirelli',marca_exige_confirmacao:true,total_stock_available:0,price_amount:null})]);
    }finally{client.release();}
    for(const table of ['matriz_product_prices','wholesale_product_prices','product_prices'])
      await expect(db.pool.query('INSERT INTO commerce.'+table+"(environment,product_id,price_amount) VALUES('test',$1,10)",[genericId]))
        .rejects.toThrow('partner_used_not_matriz_product');
    await expect(db.pool.query("INSERT INTO commerce.stock_levels(environment,product_id,quantity_available) VALUES('test',$1,10)",[genericId]))
      .rejects.toThrow('partner_used_not_matriz_product');
  });
  it('desconta reservas do usado e proíbe baixar o saldo abaixo delas',async()=>{
    await db.pool.query('UPDATE commerce.partner_stock_levels SET quantity_reserved=2 WHERE id=$1',[stockId]);
    const client=await db.pool.connect();try{
      expect(await fulfillment.mapProductToPartnerStock(client,'test',a.unitId,genericId,4)).toBeNull();
      expect(await fulfillment.mapProductToPartnerStock(client,'test',a.unitId,genericId,3)).toMatchObject({partner_stock_id:stockId});
    }finally{client.release();}
    await expect(simple.correctSimpleOperationStockBalance(context(a),'Teste',stockId,1)).rejects.toMatchObject({code:'stock_balance_below_reserved'});
    await simple.correctSimpleOperationStockBalance(context(a),'Teste',stockId,3);
    expect((await db.pool.query('SELECT quantity_on_hand,quantity_reserved,sale_price FROM commerce.partner_stock_levels WHERE id=$1',[stockId])).rows[0])
      .toEqual({quantity_on_hand:3,quantity_reserved:2,sale_price:'55.00'});
  });
  it('TENHO confirma a marca no pedido, preserva o saldo misto e cancelar libera só a reserva',async()=>{
    const {configureTestOpeningHours,atOpenStoreTime}=await import('./helpers/store-opening-fixtures.js');
    const {createStockRequest}=await import('../../src/atendente-v2/stock-confirmation-store.js');
    const {captureConfirmedUsedBrands}=await import('../../src/atendente-v2/partner-used-order-brand.js');
    const {cancelPartnerPickup}=await import('../../src/parceiro/cancel-pickup.js');
    await configureTestOpeningHours(db.pool,a.unitId);
    const row=await simple.createSimpleOperationTire(context(a),'Teste',{...input,tire_size:'110/90-18',tire_width_mm:110});
    const productId=(await db.pool.query('SELECT product_id FROM commerce.partner_stock_levels WHERE id=$1',[row.stock_id])).rows[0].product_id;
    const conversation=(await db.pool.query("INSERT INTO core.conversations(environment,chatwoot_conversation_id,chatwoot_account_id,current_status,started_at) VALUES('test',992730001,2,'open',now()) RETURNING id")).rows[0].id;
    const routing={ctx:context(a),unitId:a.unitId,items:[{product_id:productId,partner_stock_id:row.stock_id,quantity:1,unit_price:55}]};
    const client=await db.pool.connect();let orderId:string;
    try{
      await client.query('BEGIN');
      const request=await createStockRequest(client,'test',conversation,null,
        {municipio:'Rio de Janeiro',modalidade:'pickup',customerLocation:null,clientNeighborhoodCanonical:null},routing,[],null,
        [{product_id:productId,quantity:1,requested_brand:'Pirelli'}]);
      await client.query('UPDATE commerce.partner_stock_requests SET sealed=true WHERE id=$1',[request.id]);
      await client.query('COMMIT');
      await partnerDb.withPartnerContext(a.partnerUnitId,async scoped=>{
        expect((await scoped.query('SELECT commerce.answer_partner_stock_request($1,1,true) status',[request.id])).rows[0].status).toBe('confirmed');
      });
      await client.query('BEGIN');
      const sale=await atOpenStoreTime(()=>fulfillment.materializePartnerOrder(client,context(a),{
        customer_name:'Cliente fictício local',customer_phone:null,payment_method:'Pix',
        items:[{partner_stock_id:row.stock_id,quantity:1,unit_price:55}],fulfillment_mode:'pickup',delivery_address:null,
        freight_amount:0,idempotency_key:randomUUID(),reserve_for_pickup:true,
      }));
      orderId=sale.partner_order_id;
      await captureConfirmedUsedBrands(client,'test',conversation,orderId,routing);
      await captureConfirmedUsedBrands(client,'test',conversation,orderId,routing);
      await client.query('COMMIT');
      expect((await client.query('SELECT brand,quantity,unit_price FROM commerce.partner_order_items WHERE order_id=$1',[orderId])).rows)
        .toEqual([{brand:'Pirelli',quantity:1,unit_price:'55.00'}]);
      expect((await client.query('SELECT brand,quantity_on_hand,quantity_reserved FROM commerce.partner_stock_levels WHERE id=$1',[row.stock_id])).rows[0])
        .toEqual({brand:null,quantity_on_hand:5,quantity_reserved:1});
      expect((await client.query("SELECT id FROM finance.partner_receivables WHERE environment='test' AND source_order_id=$1",[orderId])).rows).toHaveLength(0);
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    expect(await cancelPartnerPickup(context(a),orderId!,'Fim do teste descartável')).toMatchObject({cancelled:true});
    expect((await db.pool.query('SELECT brand,quantity_on_hand,quantity_reserved FROM commerce.partner_stock_levels WHERE id=$1',[row.stock_id])).rows[0])
      .toEqual({brand:null,quantity_on_hand:5,quantity_reserved:0});
  });
});

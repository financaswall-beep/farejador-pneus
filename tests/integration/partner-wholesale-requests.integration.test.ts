import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {startPostgres,stopPostgres,buildRestrictedConnectionString,type IntegrationDb} from './helpers/postgres.js';
import {createPartnerFixture} from './helpers/partner-fixtures.js';
let db:IntegrationDb;
let service:typeof import('../../src/admin/painel/queries-partner-wholesale-requests.js');
let partnerService:typeof import('../../src/parceiro/operation-buy-requests.js');
let receiptService:typeof import('../../src/admin/painel/partner-wholesale-request-receipt.js');
let payments:typeof import('../../src/admin/painel/queries-financeiro-integridade.js');
let sales:typeof import('../../src/admin/painel/queries-atacado-vendas.js');
let cargo:typeof import('../../src/admin/painel/queries-partner-cargo.js');
beforeAll(async()=>{
  Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgres://test',CHATWOOT_HMAC_SECRET:'test-secret',
    ADMIN_AUTH_TOKEN:'emergency-token',WHOLESALE_FINANCE:'true',MATRIZ_CENTRAL_LEDGER:'true'});
  db=await startPostgres(); process.env.DATABASE_URL=db.connectionString;
  process.env.PARTNER_DATABASE_URL=buildRestrictedConnectionString(db.connectionString); vi.resetModules();
  service=await import('../../src/admin/painel/queries-partner-wholesale-requests.js');
  partnerService=await import('../../src/parceiro/operation-buy-requests.js');
  receiptService=await import('../../src/admin/painel/partner-wholesale-request-receipt.js');
  payments=await import('../../src/admin/painel/queries-financeiro-integridade.js');
  sales=await import('../../src/admin/painel/queries-atacado-vendas.js');
  cargo=await import('../../src/admin/painel/queries-partner-cargo.js');
},180000);
afterAll(async()=>{
  if(db){await (await import('../../src/parceiro/db.js')).partnerPool.end();
    await (await import('../../src/persistence/db.js')).pool.end();await stopPostgres(db);}
});
async function fixture(quantity=8,reserved=0,alias=false,vehicle='motorcycle'){
  const partner=await createPartnerFixture(db.pool);
  const id=randomUUID(),catalogBrand=alias?'Pirelli':'Marca '+randomUUID().slice(0,8),catalogMeasure=alias?'93/93-19':vehicle==='car'?'195/65-15':'90/90-18';
  const brand=alias?'PIRELLI':catalogBrand,measure=alias?'939319':catalogMeasure;
  await db.pool.query(`INSERT INTO commerce.products(id,environment,product_code,product_name,product_type,brand,tire_condition)
    VALUES($1,'test',$1::uuid::text,'Pneu teste','tire',$2,'meia_vida')`,[id,catalogBrand]);
  await db.pool.query(`INSERT INTO commerce.tire_specs(environment,product_id,tire_size,vehicle_type)
    VALUES('test',$1,$2,$3)`,[id,catalogMeasure,vehicle]);
  await db.pool.query(`INSERT INTO commerce.wholesale_product_prices(environment,product_id,price_amount,valid_from)
    VALUES('test',$1,65,now()-interval '1 second')`,[id]);
  await db.pool.query(`INSERT INTO commerce.wholesale_stock(environment,measure,brand,tire_condition,quantity_on_hand,quantity_reserved,vehicle_type,unit_cost)
    VALUES('test',$1,$2,'meia_vida',$3,$4,$5,40)`,[measure,brand,quantity,reserved,vehicle]);
  const input={idempotency_key:randomUUID(),items:[{offer_key:id,quantity:3,expected_price_cents:6500}]};
  return {partner,id,brand,measure,input};
}
async function stock(f:Awaited<ReturnType<typeof fixture>>){
  return (await db.pool.query(`SELECT quantity_on_hand,quantity_reserved FROM commerce.wholesale_stock
    WHERE environment='test' AND measure=$1 AND brand=$2`,[f.measure,f.brand])).rows[0];
}
function action(id:string,what:'approve'|'reject'|'dispatch',extra:Record<string,string>={}){
  return service.decideWholesaleRequest({id,environment:'test',action:what,actor:'owner:test',...extra},db.pool);
}
const due=()=>new Date(Date.now()+7*86400000).toISOString().slice(0,10);
async function sent(f:Awaited<ReturnType<typeof fixture>>){
  return (await partnerService.submitBuyRequest(f.partner.ctx,f.input)).request_id as string;
}
describe('pedido do app → reserva → saída → entrada → pagamento separado',()=>{
  it('pneu de carro continua carro ao entrar no estoque do parceiro',async()=>{
    const f=await fixture(8,0,false,'car');const id=await sent(f);await action(id,'approve');await action(id,'dispatch',{due_date:due()});
    const row=(await partnerService.getBuyRequests(f.partner.ctx)).rows[0] as any;
    expect(row.items[0]).toMatchObject({vehicle_type:'car',measure:'195/65-15'});
    await receiptService.receiveBuyRequest(f.partner.ctx,id,{idempotency_key:randomUUID(),
      items:[{item_id:row.items[0].item_id,received_quantity:3}]},db.pool);
    expect((await db.pool.query('SELECT vehicle_type FROM commerce.partner_stock_levels WHERE unit_id=$1 AND product_id=$2',
      [f.partner.unitId,f.id])).rows).toEqual([{vehicle_type:'car'}]);
  });
  it('preserva a linha física com grafia diferente do catálogo no despacho e retorno',async()=>{
    const f=await fixture(8,0,true);
    const id=await sent(f);await action(id,'approve');await action(id,'dispatch',{due_date:due()});
    const request=(await partnerService.getBuyRequests(f.partner.ctx)).rows[0] as any;
    await receiptService.receiveBuyRequest(f.partner.ctx,id,{idempotency_key:randomUUID(),
      items:[{item_id:request.items[0].item_id,received_quantity:2}]},db.pool);
    expect(await stock(f)).toEqual({quantity_on_hand:5,quantity_reserved:0});
    const partnerStock=(await db.pool.query(`SELECT tire_size,brand FROM commerce.partner_stock_levels
      WHERE environment='test' AND unit_id=$1 AND product_id=$2`,[f.partner.unitId,f.id])).rows;
    expect(partnerStock).toEqual([{tire_size:'93/93-19',brand:'Pirelli'}]);
    const lot=(await db.pool.query(`SELECT c.id FROM commerce.matrix_partner_cargo_lots c
      JOIN commerce.wholesale_order_items i ON i.id=c.source_wholesale_order_item_id
      JOIN commerce.partner_wholesale_requests r ON r.wholesale_order_id=i.order_id WHERE r.id=$1`,[id])).rows[0];
    await cargo.returnPartnerCargoToMatrix({environment:'test',cargo_lot_id:lot.id,actor_label:'test',
      reason:'Retorno conferido',idempotency_key:randomUUID()},db.pool);
    expect(await stock(f)).toEqual({quantity_on_hand:6,quantity_reserved:0});
  });
  it('envia sem movimentar; reenvio é único, corpo diferente conflita e leitura é isolada',async()=>{
    const f=await fixture();const before=(await db.pool.query('SELECT count(*) FROM commerce.wholesale_orders')).rows[0];
    const id=await sent(f);expect(await stock(f)).toEqual({quantity_on_hand:8,quantity_reserved:0});
    expect((await db.pool.query('SELECT count(*) FROM commerce.wholesale_orders')).rows[0]).toEqual(before);
    expect(await partnerService.submitBuyRequest(f.partner.ctx,f.input)).toMatchObject({request_id:id,idempotent:true});
    await expect(partnerService.submitBuyRequest(f.partner.ctx,{...f.input,items:[{...f.input.items[0]!,quantity:2}]})).rejects.toThrow('idempotency_conflict');
    expect((await partnerService.getBuyRequests(f.partner.ctx)).rows).toHaveLength(1);
    const other=await createPartnerFixture(db.pool);expect((await partnerService.getBuyRequests(other.ctx)).rows).toHaveLength(0);
    await expect(receiptService.receiveBuyRequest(other.ctx,id,{idempotency_key:randomUUID(),items:[]},db.pool)).rejects.toThrow('request_not_found');
  });
  it('não escreve diretamente na central e não atende contexto ausente ou unidade suspensa',async()=>{
    const f=await fixture();const c=await db.pool.connect();
    try {await c.query('BEGIN');await c.query('SET LOCAL ROLE farejador_partner_app');
      expect((await c.query('SELECT * FROM commerce.partner_wholesale_requests')).rows).toEqual([]);
      await expect(c.query('SELECT commerce.submit_partner_wholesale_request($1,$2)',[f.input.idempotency_key,JSON.stringify(f.input.items)])).rejects.toThrow('partner_inactive');
      await c.query('ROLLBACK');await c.query('BEGIN');await c.query('SET LOCAL ROLE farejador_partner_app');
      await c.query("SELECT set_config('app.partner_unit_id',$1,true)",[f.partner.partnerUnitId]);
      await expect(c.query('UPDATE commerce.partner_wholesale_requests SET total_cents=1')).rejects.toThrow(/permission denied/);
    }finally{await c.query('ROLLBACK');c.release();}
    await db.pool.query("UPDATE network.partner_units SET status='suspended' WHERE id=$1",[f.partner.partnerUnitId]);
    await expect(sent(f)).rejects.toThrow('partner_inactive');
  });
  it('revalida o preço na aprovação, sem reservar se mudou',async()=>{
    const f=await fixture();const id=await sent(f);
    await db.pool.query(`UPDATE commerce.wholesale_product_prices SET valid_until=now() WHERE product_id=$1`,[f.id]);
    await db.pool.query(`INSERT INTO commerce.wholesale_product_prices(environment,product_id,price_amount) VALUES('test',$1,70)`,[f.id]);
    await expect(action(id,'approve')).rejects.toThrow('price_changed');
    expect(await stock(f)).toEqual({quantity_on_hand:8,quantity_reserved:0});
  });
  it('aprovações concorrentes nunca reservam o mesmo saldo; recusa libera só a própria reserva',async()=>{
    const f=await fixture(6,2);const a=await sent(f);
    const b=(await partnerService.submitBuyRequest(f.partner.ctx,{...f.input,idempotency_key:randomUUID()})).request_id as string;
    const results=await Promise.allSettled([action(a,'approve'),action(b,'approve')]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(await stock(f)).toEqual({quantity_on_hand:6,quantity_reserved:5});
    const winner=results[0]!.status==='fulfilled'?a:b;
    expect(await action(winner,'approve')).toMatchObject({idempotent:true});
    await action(winner,'reject',{reason:'Sem transporte'});await action(winner,'reject',{reason:'Sem transporte'});
    expect(await stock(f)).toEqual({quantity_on_hand:6,quantity_reserved:2});
  });
  it('permite cancelar reserva após suspensão da unidade e bloqueia quantidade excedente',async()=>{
    const f=await fixture();const id=await sent(f);await action(id,'approve');
    await db.pool.query("UPDATE network.partner_units SET status='suspended' WHERE id=$1",[f.partner.partnerUnitId]);
    await action(id,'reject',{reason:'Unidade suspensa'});expect((await stock(f)).quantity_reserved).toBe(0);
    const g=await fixture();const other=await sent(g);await action(other,'approve');await action(other,'dispatch',{due_date:due()});
    const row=(await partnerService.getBuyRequests(g.partner.ctx)).rows[0] as any;
    await expect(receiptService.receiveBuyRequest(g.partner.ctx,other,{idempotency_key:randomUUID(),
      items:[{item_id:row.items[0].item_id,received_quantity:4}]},db.pool)).rejects.toThrow('receipt_quantity_invalid');
    expect((await partnerService.getBuyRequests(g.partner.ctx)).rows[0]).toMatchObject({receipt_status:'pending'});
  });
  it('recusa versus despacho concorrente tem uma decisão única e não deixa reserva órfã',async()=>{
    const f=await fixture();const id=await sent(f);await action(id,'approve');
    const outcomes=await Promise.allSettled([action(id,'dispatch',{due_date:due()}),action(id,'reject',{reason:'Cancelado antes da saída'})]);
    expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    const row=(await db.pool.query('SELECT status,wholesale_order_id FROM commerce.partner_wholesale_requests WHERE id=$1',[id])).rows[0];
    expect(await stock(f)).toEqual({quantity_on_hand:row.status==='dispatched'?5:8,quantity_reserved:0});
    expect(!!row.wholesale_order_id).toBe(row.status==='dispatched');
  });
  it('duas variantes e falha na entrada revertem o acerto e a carga; retry recebe uma única vez',async()=>{
    const f=await fixture(),g=await fixture();
    const id=(await partnerService.submitBuyRequest(f.partner.ctx,{idempotency_key:randomUUID(),
      items:[...f.input.items,{...g.input.items[0]!,quantity:2}]})).request_id as string;
    await action(id,'approve');await action(id,'dispatch',{due_date:due()});
    const row=(await partnerService.getBuyRequests(f.partner.ctx)).rows[0] as any;
    const input={idempotency_key:randomUUID(),items:row.items.map((item:any)=>({item_id:item.item_id,received_quantity:item.quantity-1}))};
    await db.pool.query(`CREATE FUNCTION commerce.test_reject_request_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.receipt_status='received' THEN RAISE EXCEPTION 'test_receipt_failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_request_receipt BEFORE UPDATE ON commerce.partner_purchases FOR EACH ROW
      EXECUTE FUNCTION commerce.test_reject_request_receipt()`);
    try{await expect(receiptService.receiveBuyRequest(f.partner.ctx,id,input,db.pool)).rejects.toThrow('test_receipt_failure');}
    finally{await db.pool.query('DROP TRIGGER test_request_receipt ON commerce.partner_purchases; DROP FUNCTION commerce.test_reject_request_receipt()');}
    const before=(await db.pool.query(`SELECT o.partner_transfer_status FROM commerce.wholesale_orders o
      JOIN commerce.partner_wholesale_requests r ON r.wholesale_order_id=o.id WHERE r.id=$1`,[id])).rows[0];
    expect(before.partner_transfer_status).toBe('in_transit');
    expect((await db.pool.query(`SELECT id FROM commerce.partner_stock_levels WHERE environment='test' AND unit_id=$1
      AND product_id=ANY($2::uuid[])`,[f.partner.unitId,[f.id,g.id]])).rows).toHaveLength(0);
    const result=await receiptService.receiveBuyRequest(f.partner.ctx,id,input,db.pool);
    expect(result).toMatchObject({received_units:3,expected_units:5,has_divergence:true});
    expect(await receiptService.receiveBuyRequest(f.partner.ctx,id,input,db.pool)).toMatchObject({idempotent:true});
    expect((await db.pool.query(`SELECT sum(quantity_on_hand)::int quantity FROM commerce.partner_stock_levels
      WHERE environment='test' AND unit_id=$1 AND product_id=ANY($2::uuid[])`,[f.partner.unitId,[f.id,g.id]])).rows[0].quantity).toBe(3);
  });
  it('reserva impede venda paralela e erro no despacho reverte baixa e documentos',async()=>{
    const f=await fixture(5);const id=await sent(f);await action(id,'approve');
    await expect(sales.registerWholesaleSale({environment:'test',partner_id:f.partner.partnerId,
      partner_unit_id:f.partner.partnerUnitId,created_by:'test',idempotency_key:randomUUID(),payment_status:'pending',due_date:due(),
      items:[{measure:f.measure,brand:f.brand,tire_condition:'meia_vida',quantity:3,unit_price:65}]},db.pool)).rejects.toThrow('oversell');
    await db.pool.query(`CREATE FUNCTION commerce.test_reject_request_purchase() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.product_id IS NOT NULL THEN RAISE EXCEPTION 'test_dispatch_failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_request_purchase BEFORE UPDATE ON commerce.partner_purchase_items FOR EACH ROW
      EXECUTE FUNCTION commerce.test_reject_request_purchase()`);
    try {await expect(action(id,'dispatch',{due_date:due()})).rejects.toThrow('test_dispatch_failure');}
    finally {await db.pool.query('DROP TRIGGER test_request_purchase ON commerce.partner_purchase_items; DROP FUNCTION commerce.test_reject_request_purchase()');}
    expect(await stock(f)).toEqual({quantity_on_hand:5,quantity_reserved:3});
    expect((await db.pool.query('SELECT status,wholesale_order_id FROM commerce.partner_wholesale_requests WHERE id=$1',[id])).rows[0])
      .toEqual({status:'approved',wholesale_order_id:null});
    await action(id,'dispatch',{due_date:due()});expect(await stock(f)).toEqual({quantity_on_hand:2,quantity_reserved:0});
    expect(await action(id,'dispatch',{due_date:due()})).toMatchObject({idempotent:true});
    await expect(action(id,'reject',{reason:'Voltar estoque'})).rejects.toThrow('request_state_conflict');
  });
  it('recebimento parcial entra só o aceito, preserva moto/custo e recusa continua em trânsito; pagamento uma vez',async()=>{
    const f=await fixture(10,1);const id=await sent(f);await action(id,'approve');await action(id,'dispatch',{due_date:due()});
    const own=(await partnerService.getBuyRequests(f.partner.ctx)).rows[0] as any;
    const input={idempotency_key:randomUUID(),items:[{item_id:own.items[0].item_id,received_quantity:2}]};
    const received=await receiptService.receiveBuyRequest(f.partner.ctx,id,input,db.pool);
    expect(received).toMatchObject({received:true,received_units:2});
    expect(await receiptService.receiveBuyRequest(f.partner.ctx,id,input,db.pool)).toMatchObject({idempotent:true});
    await expect(receiptService.receiveBuyRequest(f.partner.ctx,id,{...input,items:[{...input.items[0]!,received_quantity:3}]},db.pool)).rejects.toThrow('idempotency_conflict');
    expect(await stock(f)).toEqual({quantity_on_hand:7,quantity_reserved:1});
    const stored=(await db.pool.query(`SELECT product_id,vehicle_type,quantity_on_hand,average_cost::text,sale_price
      FROM commerce.partner_stock_levels WHERE environment='test' AND unit_id=$1 AND product_id=$2`,[f.partner.unitId,f.id])).rows[0];
    expect(stored).toMatchObject({product_id:f.id,vehicle_type:'motorcycle',quantity_on_hand:2,sale_price:null});
    expect(Number(stored.average_cost)).toBe(65);
    const docs=(await db.pool.query(`SELECT o.id,o.status,o.payment_status,p.receipt_status,pay.status AS payable_status
      FROM commerce.partner_wholesale_requests r JOIN commerce.wholesale_orders o ON o.id=r.wholesale_order_id
      JOIN commerce.partner_purchases p ON p.source_wholesale_order_id=o.id
      JOIN finance.partner_payables pay ON pay.source_purchase_id=p.id WHERE r.id=$1`,[id])).rows[0];
    expect(docs).toMatchObject({status:'confirmed',payment_status:'pending',receipt_status:'received',payable_status:'open'});
    const pay={idempotency_key:randomUUID(),actor_label:'owner:test'};
    await payments.settleWholesaleOrderPayment(docs.id,'test',db.pool,pay);
    await payments.settleWholesaleOrderPayment(docs.id,'test',db.pool,pay);
    expect((await partnerService.getBuyRequests(f.partner.ctx)).rows[0]).toMatchObject({payment_status:'paid',receipt_status:'received',settled_total_cents:13000});
    const matrix=(await service.listWholesaleRequests('test',db.pool)).rows.find(r=>r.id===id)!;
    expect(matrix).toMatchObject({payment_status:'paid',receipt_status:'received',status:'dispatched'});
    expect(Number(matrix.settled_total_cents)).toBe(13000);
    const lot=(await db.pool.query(`SELECT c.id,c.quantity_available FROM commerce.matrix_partner_cargo_lots c
      JOIN commerce.wholesale_order_items i ON i.id=c.source_wholesale_order_item_id WHERE i.order_id=$1`,[docs.id])).rows[0];
    expect(lot.quantity_available).toBe(1);
    await cargo.returnPartnerCargoToMatrix({environment:'test',cargo_lot_id:lot.id,
      actor_label:'owner:test',reason:'Retorno físico conferido',idempotency_key:randomUUID()},db.pool);
    expect(await stock(f)).toEqual({quantity_on_hand:8,quantity_reserved:1});
  });
});

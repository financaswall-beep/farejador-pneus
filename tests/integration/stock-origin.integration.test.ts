import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';
import { confirmStockOrigin, listStockOriginPendings } from '../../src/admin/painel/stock-origin.js';
import { saveMatrizStockGroup } from '../../src/admin/painel/stock-groups.js';
import { reserveMatrizGalpaoStock,releaseMatrizGalpaoReservation,consumeMatrizGalpaoReservation }
  from '../../src/atendente-v2/matriz-stock-reservation.js';

let db:IntegrationDb, contact:string;
beforeAll(async()=>{
  db=await startPostgres();
  Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:db.connectionString,
    CHATWOOT_HMAC_SECRET:'test',ADMIN_AUTH_TOKEN:'test',WHOLESALE_STOCK_DECREMENT:'true',DATABASE_SSL:'false'});
  await db.pool.query("INSERT INTO core.units(environment,slug,name) VALUES ('test','main','Matriz') ON CONFLICT DO NOTHING");
  contact=(await db.pool.query("INSERT INTO core.contacts(environment,chatwoot_contact_id,name) VALUES ('test',2723523,'Teste') RETURNING id")).rows[0].id;
},180000);
afterAll(async()=>{if(db) await stopPostgres(db);});

async function tx<T>(fn:(c:PoolClient)=>Promise<T>) {
  const c=await db.pool.connect();
  try {await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}
  catch(e){await c.query('ROLLBACK');throw e;} finally{c.release();}
}
async function fixture(stacks:[string,number,boolean][],unlocated=0) {
  const brand='Teste '+randomUUID().slice(0,8);
  const product=(await db.pool.query(`INSERT INTO commerce.products(environment,product_code,product_name,product_type,brand,tire_condition)
    VALUES('test',$1,$2,'tire',$2,'meia_vida') RETURNING id`,[randomUUID(),brand])).rows[0].id;
  await db.pool.query("INSERT INTO commerce.tire_specs(environment,product_id,tire_size,vehicle_type) VALUES('test',$1,'225/45 R18','car')",[product]);
  const stock=(await db.pool.query(`INSERT INTO commerce.wholesale_stock(environment,measure,brand,tire_condition,quantity_on_hand,unit_cost)
    VALUES('test','225/45 R18',$1,'meia_vida',$2,80) RETURNING id`,[brand,unlocated+stacks.reduce((s,x)=>s+x[1],0)])).rows[0].id;
  for(const [location,quantity,pair] of stacks) await saveMatrizStockGroup(db.pool,'test',{
    stock_id:stock,product_id:product,model:'Modelo fictício',inspection_status:'approved',matched_set:pair,
    positions:[{location_code:location,quantity}],reason:'Conferência real simulada',idempotency_key:randomUUID(),
  },'teste');
  return {product,stock,brand};
}
async function sell(f:{product:string;stock:string},q=1,reserve=false) {
  return tx(async c=>{
    const id=(await c.query(`INSERT INTO commerce.orders(environment,total_amount,status,fulfillment_mode,source,unit_id,idempotency_key,contact_id)
      SELECT 'test',150,'open','pickup','chatwoot_com_bot',id,$1,$2 FROM core.units WHERE environment='test' AND slug='main' RETURNING id`,
    [randomUUID(),contact])).rows[0].id;
    await c.query("INSERT INTO commerce.order_items(environment,order_id,product_id,quantity,unit_price) VALUES('test',$1,$2,$3,150)",[id,f.product,q]);
    if(reserve) {
      await reserveMatrizGalpaoStock(c,'test',id,[{productId:f.product,quantity:q}],true);
      return id as string;
    }
    await c.query("SELECT set_config('app.galpao_source','varejo',true),set_config('app.galpao_ref',$1,true)",[id]);
    await c.query("UPDATE commerce.wholesale_stock SET quantity_on_hand=quantity_on_hand-$2 WHERE environment='test' AND id=$1",[f.stock,q]);
    return id as string;
  });
}
async function cancel(stock:string,orderId:string,q=1) {
  await tx(async c=>{
    await c.query("SELECT set_config('app.galpao_source','cancelamento_varejo',true),set_config('app.galpao_ref',$1,true)",[orderId]);
    await c.query("UPDATE commerce.wholesale_stock SET quantity_on_hand=quantity_on_hand+$2 WHERE environment='test' AND id=$1",[stock,q]);
  });
}
async function balance(stock:string) {
  return (await db.pool.query(`SELECT s.quantity_on_hand total, p.location_code loc, p.quantity_on_hand qty,g.matched_set
    FROM commerce.wholesale_stock s JOIN commerce.matriz_stock_groups g ON g.stock_id=s.id AND g.environment=s.environment
    JOIN commerce.matriz_stock_group_positions p ON p.group_id=g.id AND p.environment=g.environment
    WHERE s.environment='test' AND s.id=$1 ORDER BY p.location_code,g.matched_set`,[stock])).rows;
}
const pend=(orderId:string)=>listStockOriginPendings(db.pool,'test',{orderIds:[orderId]});
describe('origem física da venda',()=>{
  it.each([true,false])('não pergunta quando outro SKU da mesma cesta precisa do único saldo sem grupo: reserva=%s',async reserve=>{
    const f=await fixture([['B2',2,true]],1);
    const other=(await db.pool.query(`INSERT INTO commerce.products(environment,product_code,product_name,product_type,brand,tire_condition)
      VALUES('test',$1,$2,'tire',$2,'meia_vida') RETURNING id`,[randomUUID(),f.brand])).rows[0].id;
    // Simula fichas históricas, anteriores às restrições de variante, no banco descartável.
    await tx(async c=>{
      await c.query('ALTER TABLE commerce.tire_specs DISABLE TRIGGER catalog_tire_variant_from_spec');
      await c.query('ALTER TABLE commerce.tire_specs DISABLE TRIGGER tire_catalog_variant_unique');
      await c.query("INSERT INTO commerce.tire_specs(environment,product_id,tire_size,vehicle_type) VALUES('test',$1,'225/45 R18','car')",[other]);
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      await c.query('ALTER TABLE commerce.tire_specs ENABLE TRIGGER catalog_tire_variant_from_spec');
      await c.query('ALTER TABLE commerce.tire_specs ENABLE TRIGGER tire_catalog_variant_unique');
    });
    const order=await tx(async c=>{
      const id=(await c.query(`INSERT INTO commerce.orders(environment,total_amount,status,fulfillment_mode,source,unit_id,idempotency_key,contact_id)
        SELECT 'test',300,'open','pickup','chatwoot_com_bot',id,$1,$2 FROM core.units WHERE environment='test' AND slug='main' RETURNING id`,
      [randomUUID(),contact])).rows[0].id;
      await c.query("INSERT INTO commerce.order_items(environment,order_id,product_id,quantity,unit_price) VALUES('test',$1,$2,1,150),('test',$1,$3,1,150)",[id,f.product,other]);
      if(reserve) await reserveMatrizGalpaoStock(c,'test',id,[{productId:f.product,quantity:1},{productId:other,quantity:1}],true);
      else {
        await c.query("SELECT set_config('app.galpao_source','varejo',true),set_config('app.galpao_ref',$1,true)",[id]);
        await c.query("UPDATE commerce.wholesale_stock SET quantity_on_hand=quantity_on_hand-2 WHERE environment='test' AND id=$1",[f.stock]);
      }
      return id as string;
    });
    expect(await pend(order)).toEqual([]);
  });
  it('mantém as opções da venda original após corrigir o modelo do catálogo',async()=>{
    const f=await fixture([['B2',2,true],['C2',1,false]]);
    const id=await sell(f);
    await db.pool.query("UPDATE commerce.tire_specs SET tread_pattern='Modelo atualizado' WHERE environment='test' AND product_id=$1",[f.product]);
    const [p]=await pend(id);
    const candidate=p!.candidates.find(c=>c.location_code==='B2')!;
    expect(candidate.available).toBe(2);
    await confirmStockOrigin(db.pool,'test',{pending_id:p!.id,idempotency_key:randomUUID(),
      selections:[{candidate_id:candidate.candidate_id,quantity:1}]},'teste');
    expect(await balance(f.stock)).toMatchObject([{total:2,qty:1},{total:2,qty:1}]);
    await cancel(f.stock,id);
    await expect(sell(f)).rejects.toThrow('stock_group_protected');
    expect(await listStockOriginPendings(db.pool,'test',{stockId:f.stock})).toEqual([]);
  });
  it.each([true,false])('realoca reserva aberta mantendo o saldo físico até realização ou liberação: realiza=%s',async consume=>{
    const f=await fixture([['B2',2,true],['C2',1,false]]);
    const id=await sell(f,1,true);
    const [p]=await pend(id);
    expect(p?.candidates.find(c=>c.location_code==='C2')?.suggested_quantity).toBe(1);
    const pick={candidate_id:p!.candidates.find(c=>c.location_code==='B2')!.candidate_id,quantity:1};
    const input={pending_id:p!.id,selections:[pick],idempotency_key:randomUUID()};
    await Promise.all([confirmStockOrigin(db.pool,'test',input,'teste'),confirmStockOrigin(db.pool,'test',input,'teste')]);
    expect((await db.pool.query('SELECT quantity_on_hand,quantity_reserved FROM commerce.wholesale_stock WHERE id=$1',[f.stock])).rows[0])
      .toEqual({quantity_on_hand:3,quantity_reserved:1});
    if(consume) {
      await tx(c=>consumeMatrizGalpaoReservation(c,'test',id));
      expect(await balance(f.stock)).toMatchObject([{total:2,qty:1},{total:2,qty:1}]);
      await cancel(f.stock,id);
    } else await tx(c=>releaseMatrizGalpaoReservation(c,'test',id));
    expect(await balance(f.stock)).toMatchObject([{total:3,qty:2},{total:3,qty:1}]);
  });
  it('referência do atacado permite identificar a pilha real e estornar pela origem corrigida',async()=>{
    const f=await fixture([['B2',2,true],['C2',1,false]]);
    const brand=(await db.pool.query('SELECT brand FROM commerce.wholesale_stock WHERE id=$1',[f.stock])).rows[0].brand;
    const {registerWholesaleSale}=await import('../../src/admin/painel/queries-atacado-vendas.js');
    const {cancelWholesaleSale}=await import('../../src/admin/painel/queries-atacado-cancelar.js');
    const sale=await registerWholesaleSale({environment:'test',new_customer:{name:'Comprador de teste'},created_by:'teste',
      idempotency_key:randomUUID(),items:[{measure:'225/45 R18',brand,tire_condition:'meia_vida',quantity:1,unit_price:120}]},db.pool);
    const [p]=await listStockOriginPendings(db.pool,'test',{stockId:f.stock});
    expect(p).toMatchObject({order_id:null,order_number:sale.order_id});
    await confirmStockOrigin(db.pool,'test',{pending_id:p!.id,idempotency_key:randomUUID(),
      selections:[{candidate_id:p!.candidates.find(c=>c.location_code==='B2')!.candidate_id,quantity:1}]},'teste');
    expect(await balance(f.stock)).toMatchObject([{total:2,qty:1},{total:2,qty:1}]);
    await cancelWholesaleSale({environment:'test',order_id:sale.order_id,cancelled_by:'teste',reason:'Venda de teste cancelada',idempotency_key:randomUUID()},db.pool);
    expect(await balance(f.stock)).toMatchObject([{total:3,qty:2},{total:3,qty:1}]);
  });
  it.each([false,true])('aceita declarações de duas vendas em qualquer ordem, sem baixar novamente (inverter=%s)',async reverse=>{
    const f=await fixture([['B2',2,true],['C2',1,false]]);
    const a=await sell(f), b=await sell(f);
    const check=async(order:string,loc:string)=>{
      const [p]=await pend(order);
      expect(p?.candidates.map(c=>c.location_code).sort()).toEqual(['B2','C2']);
      const confirm={pending_id:p!.id,idempotency_key:randomUUID(),selections:[{candidate_id:p!.candidates.find(c=>c.location_code===loc)!.candidate_id,quantity:1}]};
      const res=await confirmStockOrigin(db.pool,'test',confirm,'teste',order);
      expect(await confirmStockOrigin(db.pool,'test',confirm,'teste',order)).toEqual(res);
      await expect(confirmStockOrigin(db.pool,'test',confirm,'teste',randomUUID())).rejects.toThrow('stock_origin_not_found');
    };
    if(reverse){await check(b,'C2');await check(a,'B2');}else{await check(a,'B2');await check(b,'C2');}
    expect(await balance(f.stock)).toMatchObject([{total:1,loc:'B2',qty:1},{total:1,loc:'C2',qty:0}]);
    await cancel(f.stock,a);await cancel(f.stock,b);
    expect(await balance(f.stock)).toMatchObject([{total:3,loc:'B2',qty:2},{total:3,loc:'C2',qty:1}]);
  });
  it('cancela a pendência sem confirmar e separa conjunto e avulso na mesma pilha',async()=>{
    const f=await fixture([['B2',2,true],['B2',1,false]]);
    const id=await sell(f);
    const [p]=await pend(id);
    expect(p?.candidates).toHaveLength(2);
    expect(p?.candidates.every(c=>c.location_code==='B2')).toBe(true);
    await cancel(f.stock,id);
    expect(await pend(id)).toEqual([]);
    await expect(confirmStockOrigin(db.pool,'test',{pending_id:p!.id,idempotency_key:randomUUID(),
      selections:[{candidate_id:p!.candidates[0]!.candidate_id,quantity:1}]},'teste')).rejects.toThrow('stock_origin_changed');
    expect(await balance(f.stock)).toMatchObject([{total:3,qty:1,matched_set:false},{total:3,qty:2,matched_set:true}]);
  });
  it('omite a pergunta para só avulsos, origem única e venda de todas as origens',async()=>{
    for(const [stacks,q] of [
      [[['A1',1,false],['A2',1,false]],1],[[['B2',2,true]],1],[[['B2',2,true],['C2',1,false]],3],
    ] as [[string,number,boolean][],number][]) {
      const f=await fixture(stacks);
      expect(await pend(await sell(f,q))).toEqual([]);
    }
  });
  it('troca sugestão sem grupo pelo par e recompõe a pilha no cancelamento',async()=>{
    const f=await fixture([['B2',2,true]],1);
    const id=await sell(f);
    const [p]=await pend(id);
    expect(p?.candidates.find(c=>c.location_code===null)?.suggested_quantity).toBe(1);
    const input={pending_id:p!.id,selections:[{candidate_id:p!.candidates.find(c=>c.matched_set)!.candidate_id,quantity:1}],idempotency_key:randomUUID()};
    await expect(confirmStockOrigin(db.pool,'prod',input,'teste')).rejects.toThrow('stock_origin_not_found');
    await confirmStockOrigin(db.pool,'test',input,'teste');
    expect(await balance(f.stock)).toMatchObject([{total:2,loc:'B2',qty:1}]);
    await cancel(f.stock,id);
    expect(await balance(f.stock)).toMatchObject([{total:3,qty:2}]);
  });
});

import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';
import {
  listAvailableMatrizStockGroups, listMatrizOrderGroupPositions, listMatrizStockGroups,
  moveMatrizStockGroup, saveMatrizStockGroup,
} from '../../src/admin/painel/stock-groups.js';
import {
  applyMatrizReservationEdit, consumeMatrizGalpaoReservation, planMatrizReservationEdit,
  releaseMatrizGalpaoReservation, releaseRemovedMatrizItems, reserveMatrizGalpaoStock,
} from '../../src/atendente-v2/matriz-stock-reservation.js';

describe('grupos físicos conferidos do galpão da Matriz', () => {
  let db: IntegrationDb;
  let contactId: string;
  beforeAll(async () => {
    db = await startPostgres();
    Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:db.connectionString,
      CHATWOOT_HMAC_SECRET:'test-secret',ADMIN_AUTH_TOKEN:'test-admin-token',BOT_PICKUP_RESERVATION_HOURS:'24'});
    await db.pool.query(`INSERT INTO core.units(environment,slug,name) VALUES ('test','main','Matriz') ON CONFLICT DO NOTHING`);
    contactId=(await db.pool.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name)
      VALUES ('test',2953523,'Cliente de testes') RETURNING id`)).rows[0].id;
  },180_000);
  afterAll(async () => { if (db) await stopPostgres(db); });

  async function tx<T>(fn: (client: PoolClient)=>Promise<T>): Promise<T> {
    const client=await db.pool.connect();
    try {
      await client.query('BEGIN');
      const result=await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function fixture(brand: string, quantity: number) {
    const measure='225/45-18';
    const p=await db.pool.query<{id:string}>(`INSERT INTO commerce.products
      (environment,product_code,product_name,product_type,brand,tire_condition)
      VALUES ('test',$1,$2,'tire',$2,'meia_vida') RETURNING id`,[randomUUID(),brand]);
    const productId=p.rows[0]!.id;
    await db.pool.query(`INSERT INTO commerce.tire_specs
      (environment,product_id,tire_size,width_mm,aspect_ratio,rim_diameter,vehicle_type)
      VALUES ('test',$1,$2,225,45,18,'car')`,[productId,measure]);
    const s=await db.pool.query<{id:string}>(`INSERT INTO commerce.wholesale_stock
      (environment,measure,brand,tire_condition,quantity_on_hand,unit_cost)
      VALUES ('test',$1,$2,'meia_vida',$3,80) RETURNING id`,[measure,brand,quantity]);
    const stockId=s.rows[0]!.id;
    return {stockId,productId,measure,brand};
  }

  async function order(client: PoolClient, productId: string, quantity: number) {
    const result=await client.query<{id:string}>(`INSERT INTO commerce.orders
      (environment,total_amount,status,fulfillment_mode,source,unit_id,idempotency_key,contact_id)
      SELECT 'test',$1,'open','pickup','chatwoot_com_bot',u.id,$2,$3 FROM core.units u WHERE u.environment='test' AND u.slug='main'
      RETURNING id`,[quantity*115,`bot:order:${randomUUID()}`,contactId]);
    const id=result.rows[0]!.id;
    await client.query(`INSERT INTO commerce.order_items(environment,order_id,product_id,quantity,unit_price)
      VALUES ('test',$1,$2,$3,115)`,[id,productId,quantity]);
    return id;
  }

  async function stock(stockId: string) {
    return (await db.pool.query(`SELECT quantity_on_hand,quantity_reserved,
      commerce.matriz_stock_inspection_unavailable(environment,id) unavailable
      FROM commerce.wholesale_stock WHERE environment='test' AND id=$1`,[stockId])).rows[0];
  }

  it('recebe localização sem modelo, registra conferência e preserva o saldo oficial', async () => {
    const f=await fixture('GolfTeste',8);
    const input={stock_id:f.stockId,product_id:f.productId,inspection_status:'located' as const,matched_set:false,
      positions:[{location_code:' a1 ',quantity:3}],reason:'Conferência de pilha',idempotency_key:randomUUID()};
    const saved=await saveMatrizStockGroup(db.pool,'test',input,'teste');
    expect(saved).toMatchObject({model:null,quantity_available:3,positions:[{location_code:'A1',quantity_on_hand:3}]});
    expect(await saveMatrizStockGroup(db.pool,'test',input,'teste')).toEqual(saved);
    expect(await listAvailableMatrizStockGroups(db.pool,'test',{measure:f.measure,brand:f.brand,quantity:2})).toEqual([]);
    const moved=await moveMatrizStockGroup(db.pool,'test',{group_id:saved.group_id,revision:saved.revision,
      from_location:'A1',to_location:'B2',quantity:2,reason:'Reorganização',idempotency_key:randomUUID()},'teste');
    expect(moved).toMatchObject({positions:[{location_code:'A1',quantity_on_hand:1},{location_code:'B2',quantity_on_hand:2}]});
    expect(await stock(f.stockId)).toEqual({quantity_on_hand:8,quantity_reserved:0,unavailable:0});
  });

  it('trava a última dupla em concorrência e libera a posição no cancelamento/expiração', async () => {
    const f=await fixture('SportTeste',2);
    const group=await saveMatrizStockGroup(db.pool,'test',{stock_id:f.stockId,product_id:f.productId,model:'Sport S',
      inspection_status:'approved',matched_set:true,positions:[{location_code:'A1',quantity:1},{location_code:'B2',quantity:1}],
      reason:'Par conferido',idempotency_key:randomUUID()},'teste');
    const reserve=()=>tx(async client=>{
      const id=await order(client,f.productId,2);
      await reserveMatrizGalpaoStock(client,'test',id,[{productId:f.productId,quantity:2}],true,
        {groupId:group.group_id,productId:f.productId,quantity:2,revision:group.revision});
      return id;
    });
    const outcomes=await Promise.allSettled([reserve(),reserve()]);
    expect(outcomes.map(r=>r.status).sort(),outcomes.map(r=>r.status==='rejected'?String(r.reason):r.value).join(' | '))
      .toEqual(['fulfilled','rejected']);
    const winner=outcomes.find(r=>r.status==='fulfilled');
    if (!winner) throw new Error('sem reserva vencedora');
    expect(await listMatrizOrderGroupPositions(db.pool,'test',winner.value)).toMatchObject([
      {location_code:'A1',quantity:1,status:'reserved'},{location_code:'B2',quantity:1,status:'reserved'},
    ]);
    await expect(tx(client=>planMatrizReservationEdit(client,'test',winner.value,
      [{productId:f.productId,quantity:2}],[{productId:f.productId,quantity:1}]))).rejects.toThrow('stock_group_not_editable');
    await db.pool.query(`UPDATE commerce.orders SET created_at=now()-interval '25 hours' WHERE id=$1`,[winner.value]);
    const {expireBotReservations}=await import('../../src/operation/bot-reservations.js');
    expect(await expireBotReservations('test',db.pool)).toBe(1);
    await tx(client=>releaseMatrizGalpaoReservation(client,'test',winner.value));
    expect(await stock(f.stockId)).toEqual({quantity_on_hand:2,quantity_reserved:0,unavailable:0});
    const newOrder=await reserve();
    await tx(async client=>{
      await consumeMatrizGalpaoReservation(client,'test',newOrder);
      await consumeMatrizGalpaoReservation(client,'test',newOrder);
    });
    expect(await stock(f.stockId)).toEqual({quantity_on_hand:0,quantity_reserved:0,unavailable:0});
    expect(await listMatrizOrderGroupPositions(db.pool,'test',newOrder)).toMatchObject([
      {location_code:'A1',status:'consumed'},{location_code:'B2',status:'consumed'},
    ]);
  });

  it('venda avulsa consome livre sem grupo primeiro e restaura a unidade agrupada apenas uma vez', async () => {
    const f=await fixture('CruiserTeste',5);
    const group=await saveMatrizStockGroup(db.pool,'test',{stock_id:f.stockId,product_id:f.productId,model:'Cruiser 1',
      inspection_status:'approved',matched_set:true,positions:[{location_code:'B1',quantity:4}],
      reason:'Jogo conferido',idempotency_key:randomUUID()},'teste');
    const id=await tx(async client=>{
      const orderId=await order(client,f.productId,2);
      await client.query(`SELECT set_config('app.galpao_source','varejo',true),set_config('app.galpao_ref',$1,true)`,[orderId]);
      await client.query(`UPDATE commerce.wholesale_stock SET quantity_on_hand=quantity_on_hand-2 WHERE environment='test' AND id=$1`,[f.stockId]);
      return orderId;
    });
    expect(await listMatrizStockGroups(db.pool,'test',f.stockId)).toMatchObject([{group_id:group.group_id,quantity_on_hand:3}]);
    await tx(async client=>{
      await client.query(`SELECT set_config('app.galpao_source','cancelamento_varejo',true),set_config('app.galpao_ref',$1,true)`,[id]);
      await client.query(`UPDATE commerce.wholesale_stock SET quantity_on_hand=quantity_on_hand+2 WHERE environment='test' AND id=$1`,[f.stockId]);
    });
    expect(await listMatrizStockGroups(db.pool,'test',f.stockId)).toMatchObject([{group_id:group.group_id,quantity_on_hand:4}]);
    expect(await listMatrizOrderGroupPositions(db.pool,'test',id)).toMatchObject([{status:'released',location_code:'B1',quantity:1}]);
    const movements=await db.pool.query(`SELECT movement_type,quantity FROM commerce.matriz_stock_group_movements
      WHERE environment='test' AND group_id=$1 AND order_id=$2 ORDER BY movement_type`,[group.group_id,id]);
    expect(movements.rows).toEqual([{movement_type:'consume',quantity:1},{movement_type:'return',quantity:1}]);
  });

  it('realoca pedidos avulsos editados e protege posições reservadas pelos outros pedidos', async () => {
    const f=await fixture('EditavelTeste',4);
    await saveMatrizStockGroup(db.pool,'test',{stock_id:f.stockId,product_id:f.productId,
      inspection_status:'located',positions:[{location_code:'E1',quantity:3}],reason:'Local conferido',idempotency_key:randomUUID()},'teste');
    const reserve=()=>tx(async client=>{
      const id=await order(client,f.productId,1);
      await reserveMatrizGalpaoStock(client,'test',id,[{productId:f.productId,quantity:1}],true);
      return id;
    });
    const first=await reserve();
    const other=await reserve();
    expect(await listMatrizOrderGroupPositions(db.pool,'test',first)).toEqual([]);
    expect(await listMatrizOrderGroupPositions(db.pool,'test',other)).toMatchObject([{location_code:'E1',quantity:1,status:'reserved'}]);
    const original={productId:f.productId,quantity:1};
    const changed={...original,quantity:2};
    await tx(async client=>{
      const plan=await planMatrizReservationEdit(client,'test',first,[original],[changed]);
      await applyMatrizReservationEdit(client,'test',first,plan);
      await client.query(`UPDATE commerce.order_items SET quantity=2 WHERE environment='test' AND order_id=$1`,[first]);
    });
    expect(await listMatrizOrderGroupPositions(db.pool,'test',first)).toMatchObject([{location_code:'E1',quantity:1,status:'reserved'}]);
    expect(await stock(f.stockId)).toEqual({quantity_on_hand:4,quantity_reserved:3,unavailable:0});
    await tx(async client=>{
      await releaseRemovedMatrizItems(client,'test',first,[changed]);
      await client.query(`DELETE FROM commerce.order_items WHERE environment='test' AND order_id=$1`,[first]);
    });
    expect(await stock(f.stockId)).toEqual({quantity_on_hand:4,quantity_reserved:1,unavailable:0});
    expect(await listMatrizOrderGroupPositions(db.pool,'test',other)).toMatchObject([{location_code:'E1',quantity:1,status:'reserved'}]);
  });

  it('protege grupos bloqueados, inclusive em baixas comerciais fora da criação do bot', async () => {
    const f=await fixture('RoadTeste',3);
    await saveMatrizStockGroup(db.pool,'test',{stock_id:f.stockId,product_id:f.productId,
      inspection_status:'blocked',positions:[{location_code:'D1',quantity:2}],reason:'Aguardar inspeção',idempotency_key:randomUUID()},'teste');
    expect(await stock(f.stockId)).toEqual({quantity_on_hand:3,quantity_reserved:0,unavailable:2});
    await expect(tx(async client=>{
      await client.query(`SELECT set_config('app.galpao_source','venda_atacado',true)`);
      await client.query(`UPDATE commerce.wholesale_stock SET quantity_on_hand=quantity_on_hand-2 WHERE environment='test' AND id=$1`,[f.stockId]);
    })).rejects.toThrow('stock_group_protected');
    expect(await stock(f.stockId)).toEqual({quantity_on_hand:3,quantity_reserved:0,unavailable:2});
    expect(await listAvailableMatrizStockGroups(db.pool,'test',{measure:f.measure,brand:f.brand,quantity:1})).toEqual([]);
  });

  it('mantém pilhas e invalida a oferta antiga quando a Matriz corrige a marca', async () => {
    const f=await fixture('MarcaErradaTeste',3);
    const group=await saveMatrizStockGroup(db.pool,'test',{stock_id:f.stockId,product_id:f.productId,model:'S',
      inspection_status:'approved',matched_set:true,positions:[{location_code:'D2',quantity:2}],
      reason:'Par conferido',idempotency_key:randomUUID()},'teste');
    const {correctWholesaleStockBrand}=await import('../../src/admin/painel/queries-stock-brand-correction.js');
    const result=await correctWholesaleStockBrand({environment:'test',measure:f.measure,from_brand:f.brand,
      to_brand:'MarcaCorrigidaTeste',tire_condition:'meia_vida',reason:'Corrigida no flanco',idempotency_key:randomUUID()},db.pool);
    expect(result.stock_id).toBe(f.stockId);
    const [updated]=await listMatrizStockGroups(db.pool,'test',f.stockId);
    expect(updated).toMatchObject({group_id:group.group_id,product_id:f.productId,brand:'MarcaCorrigidaTeste',
      positions:[{location_code:'D2',quantity_on_hand:2}]});
    expect(updated?.revision).not.toBe(group.revision);
  });

  it('valida modelo do SKU e exige reconferência de um conjunto suspenso', async () => {
    const f=await fixture('PatternTeste',4);
    await db.pool.query(`UPDATE commerce.tire_specs SET tread_pattern='Primacy 4'
      WHERE environment='test' AND product_id=$1`,[f.productId]);
    const base={stock_id:f.stockId,product_id:f.productId,reason:'Modelo conferido no flanco'};
    const input={...base,model:'Primacy 5',inspection_status:'approved' as const,matched_set:true,
      conservation_grade:'selecionado' as const,conservation_note:'Nota interna preservada',
      positions:[{location_code:'C1',quantity:4}],idempotency_key:randomUUID()};
    await expect(saveMatrizStockGroup(db.pool,'test',input,'teste')).rejects.toThrow('stock_group_product_mismatch');
    const group=await saveMatrizStockGroup(db.pool,'test',{...input,model:'primacy   4'},'teste');
    expect(await listAvailableMatrizStockGroups(db.pool,'test',{measure:f.measure,brand:f.brand,quantity:4}))
      .toMatchObject([{group_id:group.group_id,conservation_grade:'selecionado'}]);
    const blocked=await saveMatrizStockGroup(db.pool,'test',{...base,group_id:group.group_id,
      revision:group.revision,inspection_status:'blocked',idempotency_key:randomUUID()},'teste');
    expect(blocked).toMatchObject({matched_set:false,model:'primacy   4',conservation_grade:null,
      conservation_note:'Nota interna preservada'});
    expect(await stock(f.stockId)).toEqual({quantity_on_hand:4,quantity_reserved:0,unavailable:4});
    const unchecked=await saveMatrizStockGroup(db.pool,'test',{...base,group_id:group.group_id,
      revision:blocked.revision,inspection_status:'approved',conservation_note:null,idempotency_key:randomUUID()},'teste');
    expect(unchecked).toMatchObject({matched_set:false,model:'primacy   4',conservation_grade:null,conservation_note:null});
    const approved=await saveMatrizStockGroup(db.pool,'test',{...base,group_id:group.group_id,
      revision:unchecked.revision,matched_set:true,inspection_status:'approved',idempotency_key:randomUUID()},'teste');
    expect(approved.matched_set).toBe(true);
    await db.pool.query(`UPDATE commerce.tire_specs SET tread_pattern='Primacy 5'
      WHERE environment='test' AND product_id=$1`,[f.productId]);
    expect(await listAvailableMatrizStockGroups(db.pool,'test',{measure:f.measure,brand:f.brand,quantity:4})).toEqual([]);
    expect(await stock(f.stockId)).toEqual({quantity_on_hand:4,quantity_reserved:0,unavailable:4});
  });
});

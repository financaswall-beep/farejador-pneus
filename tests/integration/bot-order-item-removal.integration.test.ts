import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';
import { reserveMatrizGalpaoStock } from '../../src/atendente-v2/matriz-stock-reservation.js';

let db: IntegrationDb, unit: string, car: string, moto: string, sequence = 970000;
let execute: typeof import('../../src/atendente-v2/tools.js').executeTool;
let complete: typeof import('../../src/admin/painel/queries-pedidos-acoes.js').completeMatrizPickup;
let cancel: typeof import('../../src/admin/painel/queries-pickup-cancel.js').cancelMatrizPickup;
beforeAll(async()=>{
  db=await startPostgres();
  Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:db.connectionString,
    CHATWOOT_HMAC_SECRET:'test',ADMIN_AUTH_TOKEN:'test',MATRIZ_CENTRAL_LEDGER:'true'});
  vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Rede externa proibida');}));
  execute=(await import('../../src/atendente-v2/tools.js')).executeTool;
  complete=(await import('../../src/admin/painel/queries-pedidos-acoes.js')).completeMatrizPickup;
  cancel=(await import('../../src/admin/painel/queries-pickup-cancel.js')).cancelMatrizPickup;
  unit=(await db.pool.query(`INSERT INTO core.units(environment,slug,name,is_active) VALUES('test','main','Matriz',true)
    ON CONFLICT(environment,slug) DO UPDATE SET is_active=true RETURNING id`)).rows[0].id;
  const ids:string[]=[];
  for(const [code,measure,cost] of [['REMOVE-CAR','175/65-14',60],['REMOVE-MOTO','90/90-12',12]]) {
    const id=(await db.pool.query(`INSERT INTO commerce.products(environment,product_code,product_name,product_type,brand,tire_condition)
      VALUES('test',$1,$2,'tire','Pirelli','meia_vida') RETURNING id`,[code,measure])).rows[0].id;
    ids.push(id);
    await db.pool.query(`INSERT INTO commerce.tire_specs(environment,product_id,tire_size) VALUES('test',$1,$2)`,[id,measure]);
    await db.pool.query(`INSERT INTO commerce.wholesale_stock(environment,measure,brand,tire_condition,quantity_on_hand,unit_cost)
      VALUES('test',$1,'Pirelli','meia_vida',1,$2)`,[measure,cost]);
  }
  [car,moto]=ids as [string,string];
},180000);
afterAll(async()=>{vi.unstubAllGlobals();if(db)await stopPostgres(db);});
beforeEach(async()=>{
  await db.pool.query(`UPDATE commerce.wholesale_stock SET quantity_on_hand=1,quantity_reserved=0
    WHERE environment='test' AND brand='Pirelli' AND measure IN ('175/65-14','90/90-12')`);
});
async function transaction(work:(client:PoolClient)=>Promise<void>) {
  const client=await db.pool.connect();
  try{await client.query('BEGIN');await work(client);await client.query('COMMIT');}
  catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function fixture(mode='pickup') {
  const cw=++sequence;
  const contact=(await db.pool.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name)
    VALUES('test',$1,'Cliente teste') RETURNING id`,[cw])).rows[0].id;
  const conversation=(await db.pool.query(`INSERT INTO core.conversations(environment,chatwoot_conversation_id,chatwoot_account_id,
    contact_id,current_status,started_at) VALUES('test',$1,1,$2,'open',now()) RETURNING id`,[cw,contact])).rows[0].id;
  const order=(await db.pool.query(`INSERT INTO commerce.orders(environment,unit_id,contact_id,source_conversation_id,total_amount,
    status,fulfillment_mode,payment_method,source,delivery_address)
    VALUES('test',$1,$2,$3,$4,'open',$5,'pix','chatwoot_com_bot','Rua Teste, 1, Centro, Itaboraí') RETURNING id,order_number`,
    [unit,contact,conversation,mode==='delivery'?187.90:178,mode])).rows[0];
  await db.pool.query(`INSERT INTO commerce.order_items(environment,order_id,product_id,quantity,unit_price,matriz_unit_cost)
    VALUES('test',$1,$2,1,89,60),('test',$1,$3,1,89,12)`,[order.id,car,moto]);
  await transaction(client=>reserveMatrizGalpaoStock(client,'test',order.id,[{productId:car,quantity:1},{productId:moto,quantity:1}],true));
  return {...order,conversation,contact};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function remove(f:Fixture,ids=[car],conversation=f.conversation,environment:'test'|'prod'='test') {
  const client=await db.pool.connect();
  try{return JSON.parse(await execute(client,environment,conversation,'editar_pedido',{
    order_number:f.order_number,remover_itens:ids,motivo:'Tira o de carro e deixa só o de moto',
  }));}finally{client.release();}
}
async function state(f:Fixture) {
  return {
    order:(await db.pool.query(`SELECT status,total_amount FROM commerce.orders WHERE id=$1`,[f.id])).rows[0],
    items:(await db.pool.query(`SELECT product_id,quantity,unit_price,matriz_unit_cost FROM commerce.order_items WHERE order_id=$1 ORDER BY product_id`,[f.id])).rows,
    stock:(await db.pool.query(`SELECT measure,quantity_on_hand,quantity_reserved FROM commerce.wholesale_stock WHERE environment='test'
      AND brand='Pirelli' AND measure IN ('175/65-14','90/90-12') ORDER BY measure`)).rows,
    ledger:(await db.pool.query(`SELECT source_type,amount FROM finance.matriz_ledger_transactions WHERE environment='test' AND source_id=$1 ORDER BY source_type`,[f.id])).rows,
  };
}
describe('remoção de um pneu reservado pelo bot',()=>{
  it('consulta IDs reais, remove carro, mantém moto e custo, repete sem liberar duas vezes',async()=>{
    const f=await fixture();
    const client=await db.pool.connect();
    try{
      const consultation=JSON.parse(await execute(client,'test',f.conversation,'consultar_pedido',{order_number:f.order_number}));
      expect(consultation.pedidos[0].itens.map((i:any)=>i.product_id).sort()).toEqual([car,moto].sort());
    }finally{client.release();}
    expect(await remove(f)).toMatchObject({ok:true,total:'89.00',sem_alteracao:false,itens:[{product_id:moto,quantidade:1}]});
    const after=await state(f);
    expect(after.order).toEqual({status:'open',total_amount:'89.00'});
    expect(after.items.map(row=>({...row,matriz_unit_cost:Number(row.matriz_unit_cost)})))
      .toEqual([{product_id:moto,quantity:1,unit_price:'89.00',matriz_unit_cost:12}]);
    expect(after.stock).toEqual([
      {measure:'175/65-14',quantity_on_hand:1,quantity_reserved:0},
      {measure:'90/90-12',quantity_on_hand:1,quantity_reserved:1},
    ]);
    expect(after.ledger).toEqual([]);
    expect(await remove(f)).toMatchObject({ok:true,total:'89.00',sem_alteracao:true});
    expect(await state(f)).toEqual(after);
    const audit=(await db.pool.query(`SELECT payload_before,payload_after FROM audit.events
      WHERE entity_id=$1 AND event_type='bot_order_items_removed'`,[f.id])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].payload_before.items).toHaveLength(2);
  });

  it('conclui retirada debitando só moto, com receita 89 e custo 12',async()=>{
    const f=await fixture();expect((await remove(f)).ok).toBe(true);
    await complete({environment:'test',order_id:f.id,actor_label:'test',payment_method:'pix'},db.pool);
    const after=await state(f);
    expect(after.stock).toEqual([{measure:'175/65-14',quantity_on_hand:1,quantity_reserved:0},
      {measure:'90/90-12',quantity_on_hand:0,quantity_reserved:0}]);
    expect(after.ledger).toEqual([{source_type:'commerce.order.cogs',amount:'12.00'},
      {source_type:'commerce.order.revenue',amount:'89.00'}]);
  });

  it('cancelamento depois da edição libera só a reserva restante, sem receita',async()=>{
    const f=await fixture();expect((await remove(f)).ok).toBe(true);
    await cancel({environment:'test',order_id:f.id,actor_label:'test',reason:'cancelar teste'},db.pool);
    const after=await state(f);
    expect(after.order.status).toBe('cancelled');
    expect(after.stock.every(row=>row.quantity_on_hand===1&&row.quantity_reserved===0)).toBe(true);
    expect(after.ledger).toEqual([]);
  });

  it('preserva o frete na entrega ainda não despachada',async()=>{
    const f=await fixture('delivery');
    expect(await remove(f)).toMatchObject({ok:true,total:'98.90',modalidade:'delivery'});
  });

  it('não permite remover todos os pneus ou item que não pertence ao pedido',async()=>{
    const f=await fixture(),before=await state(f);
    expect((await remove(f,[car,moto])).erro).toContain('cancelar_pedido');
    expect((await remove(f,[randomUUID()])).erro).toContain('Item não encontrado');
    expect(await state(f)).toEqual(before);
  });

  it('não altera pedido de outro contato ou de outro ambiente',async()=>{
    const f=await fixture(),before=await state(f);
    expect((await remove(f,[car],randomUUID())).erro).toContain('não encontrado');
    expect((await remove(f,[car],f.conversation,'prod')).erro).toContain('não encontrado');
    expect(await state(f)).toEqual(before);
  });

  it('bloqueia atendimento iniciado e pagamento realizado',async()=>{
    const f=await fixture();
    await db.pool.query('UPDATE commerce.orders SET pickup_arrived_at=now() WHERE id=$1',[f.id]);
    let before=await state(f);expect((await remove(f)).erro).toContain('atendente humano');
    expect(await state(f)).toEqual(before);
    await complete({environment:'test',order_id:f.id,actor_label:'test',payment_method:'pix'},db.pool);
    before=await state(f);expect((await remove(f)).erro).toContain('atendente humano');
    expect(await state(f)).toEqual(before);
  });

  it('falha de gravação após liberar reserva desfaz itens, total e reserva juntos',async()=>{
    const f=await fixture(),before=await state(f),client=await db.pool.connect();
    const guarded={query:async(sql:string,args?:any[])=>{
      if(sql.startsWith('UPDATE commerce.orders SET total_amount'))throw Error('Falha simulada ao atualizar total');
      return client.query(sql,args);
    }} as PoolClient;
    try{
      const result=JSON.parse(await execute(guarded,'test',f.conversation,'editar_pedido',{order_number:f.order_number,remover_itens:[car]}));
      expect(result.erro).toContain('Falha simulada');
    }finally{client.release();}
    expect(await state(f)).toEqual(before);
    expect((await db.pool.query(`SELECT 1 FROM audit.events WHERE entity_id=$1
      AND event_type='matriz_galpao_reservation_adjusted'`,[f.id])).rows).toEqual([]);
  });
});

import { randomUUID } from 'node:crypto';
import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import type { PoolClient } from 'pg';
import { startPostgres,stopPostgres,type IntegrationDb } from './helpers/postgres.js';
import { reserveMatrizGalpaoStock } from '../../src/atendente-v2/matriz-stock-reservation.js';

const geo=vi.hoisted(()=>({km:30,precise:true,geocode:vi.fn(),road:vi.fn()}));
vi.mock('../../src/shared/geo/google-maps.js',()=>({geocodeAddress:geo.geocode,roadDistanceKm:geo.road}));
let db:IntegrationDb,unit:string,car:string,moto:string,replacement:string,seq=980000;
let execute:typeof import('../../src/atendente-v2/tools.js').executeTool;
let cancel:typeof import('../../src/admin/painel/queries-pickup-cancel.js').cancelMatrizPickup;
let complete:typeof import('../../src/admin/painel/queries-pedidos-acoes.js').completeMatrizPickup;
beforeAll(async()=>{
  db=await startPostgres();
  Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:db.connectionString,
    CHATWOOT_HMAC_SECRET:'test',ADMIN_AUTH_TOKEN:'test',MATRIZ_CENTRAL_LEDGER:'true',
    GOOGLE_MAPS_API_KEY:'test',GEO_CACHE:'false',ROUTING_GEO_ROAD_DISTANCE:'true'});
  vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Rede externa proibida');}));
  execute=(await import('../../src/atendente-v2/tools.js')).executeTool;
  cancel=(await import('../../src/admin/painel/queries-pickup-cancel.js')).cancelMatrizPickup;
  complete=(await import('../../src/admin/painel/queries-pedidos-acoes.js')).completeMatrizPickup;
  unit=(await db.pool.query(`INSERT INTO core.units(environment,slug,name,is_active) VALUES('test','main','Matriz',true)
    ON CONFLICT(environment,slug) DO UPDATE SET is_active=true RETURNING id`)).rows[0].id;
  const ids:string[]=[];
  for(const [code,measure,cost,price] of [['EDIT-CAR','175/65-14',60,89],['EDIT-MOTO','90/90-12',12,89],['EDIT-NEW','130/70-13',20,100]]) {
    const id=(await db.pool.query(`INSERT INTO commerce.products(environment,product_code,product_name,product_type,brand,tire_condition)
      VALUES('test',$1,$2,'tire','Pirelli','meia_vida') RETURNING id`,[code,measure])).rows[0].id;
    ids.push(id);
    await db.pool.query(`INSERT INTO commerce.tire_specs(environment,product_id,tire_size) VALUES('test',$1,$2)`,[id,measure]);
    await db.pool.query(`INSERT INTO commerce.wholesale_stock(environment,measure,brand,tire_condition,quantity_on_hand,unit_cost)
      VALUES('test',$1,'Pirelli','meia_vida',5,$2)`,[measure,cost]);
    await db.pool.query(`INSERT INTO commerce.matriz_product_prices(environment,product_id,price_amount) VALUES('test',$1,$2)`,[id,price]);
  }
  [car,moto,replacement]=ids as [string,string,string];
},180000);
afterAll(async()=>{vi.unstubAllGlobals();if(db)await stopPostgres(db);});
beforeEach(async()=>{
  geo.km=30;geo.precise=true;
  geo.geocode.mockReset().mockImplementation(async()=>geo.precise?{lat:-22.8,lng:-43,confidence:'ROOFTOP'}:null);
  geo.road.mockReset().mockImplementation(async()=>[geo.km]);
  await db.pool.query(`UPDATE commerce.wholesale_stock SET quantity_on_hand=5,quantity_reserved=0 WHERE environment='test'`);
  await db.pool.query(`UPDATE commerce.matriz_product_prices SET price_amount=100 WHERE environment='test' AND product_id=$1`,[replacement]);
  const settings={delivery_enabled:true,pickup_enabled:true,radius_km:55,address:'Matriz, 1',latitude:-22.87,longitude:-42.99,
    freight:{first_limit_km:15,first_price_brl:10,second_limit_km:25,second_price_brl:13,above_price_brl:19},
    days:[],opens_at:null,closes_at:null,delivery_days:null};
  await db.pool.query(`INSERT INTO commerce.matriz_delivery_settings(environment,settings,version,updated_by)
    VALUES('test',$1::jsonb,1,'test') ON CONFLICT(environment) DO UPDATE SET settings=EXCLUDED.settings`,[JSON.stringify(settings)]);
});
async function message(conversation:string,sender='contact',content='Pode alterar') {
  return (await db.pool.query(`INSERT INTO core.messages
    (environment,conversation_id,chatwoot_conversation_id,chatwoot_message_id,sender_type,message_type,is_private,content,sent_at)
    SELECT 'test',c.id,c.chatwoot_conversation_id,$2,$3,$4,false,$5,
      GREATEST(clock_timestamp(),COALESCE((SELECT max(sent_at)+interval '1 millisecond' FROM core.messages WHERE conversation_id=c.id),clock_timestamp()))
    FROM core.conversations c WHERE c.id=$1 RETURNING id`,[conversation,++seq,sender,sender==='contact'?0:1,content])).rows[0].id;
}
async function fixture(mode='pickup') {
  const contact=(await db.pool.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name)
    VALUES('test',$1,'Cliente teste') RETURNING id`,[++seq])).rows[0].id;
  const conversation=(await db.pool.query(`INSERT INTO core.conversations(environment,chatwoot_conversation_id,chatwoot_account_id,
    contact_id,current_status,started_at) VALUES('test',$1,1,$2,'open',now()) RETURNING id`,[++seq,contact])).rows[0].id;
  const order=(await db.pool.query(`INSERT INTO commerce.orders(environment,unit_id,contact_id,source_conversation_id,total_amount,
    status,fulfillment_mode,payment_method,source,delivery_address)
    VALUES('test',$1,$2,$3,$4,'open',$5,'pix','chatwoot_com_bot',$6) RETURNING id,order_number`,
    [unit,contact,conversation,mode==='delivery'?188:178,mode,mode==='delivery'?'Rua Antiga, 1, Niterói, RJ':null])).rows[0];
  await db.pool.query(`INSERT INTO commerce.order_items(environment,order_id,product_id,quantity,unit_price,matriz_unit_cost)
    VALUES('test',$1,$2,1,89,60),('test',$1,$3,1,89,12)`,[order.id,car,moto]);
  const c=await db.pool.connect();
  try{await c.query('BEGIN');await reserveMatrizGalpaoStock(c,'test',order.id,[{productId:car,quantity:1},{productId:moto,quantity:1}],true);await c.query('COMMIT');}
  finally{c.release();}
  await message(conversation);
  return {...order,conversation};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
const finalItems=(ids:string[],qty=1)=>ids.map(product_id=>({product_id,quantidade:qty}));
async function edit(f:Fixture,args:Record<string,unknown>,conversation=f.conversation,environment:'test'|'prod'='test',wrapped?:PoolClient) {
  const c=wrapped??await db.pool.connect();
  try{return JSON.parse(await execute(c,environment,conversation,'editar_pedido',{order_number:f.order_number,...args}));}
  finally{if(!wrapped)c.release();}
}
async function confirm(f:Fixture,quote:any) {
  await message(f.conversation,'agent_bot','Novo total. Posso atualizar?');await message(f.conversation,'contact','Sim');
  return edit(f,{confirmar_alteracao_id:quote.alteracao_id});
}
async function state(f:Fixture) {
  return {
    order:(await db.pool.query(`SELECT status,total_amount,delivery_address,payment_method,fulfillment_mode,
      geo_resolution_id,scheduled_delivery_date,unit_id FROM commerce.orders WHERE id=$1`,[f.id])).rows[0],
    items:(await db.pool.query('SELECT product_id,quantity,unit_price,matriz_unit_cost FROM commerce.order_items WHERE order_id=$1 ORDER BY product_id',[f.id])).rows,
    stock:(await db.pool.query(`SELECT measure,quantity_on_hand,quantity_reserved FROM commerce.wholesale_stock WHERE environment='test' ORDER BY measure`)).rows,
    ledger:(await db.pool.query(`SELECT source_type,amount FROM finance.matriz_ledger_transactions WHERE environment='test' AND source_id=$1 ORDER BY source_type`,[f.id])).rows,
  };
}
describe('edição de pedido com cotação e confirmação',()=>{
  it('troca entrega por retirada só após confirmação, zera frete e mantém reserva própria inclusive da última unidade',async()=>{
    const f=await fixture('delivery');
    const location=(await db.pool.query(`INSERT INTO commerce.geo_resolutions(environment,neighborhood_name,neighborhood_canonical,city_name,state_code)
      VALUES('test','Centro','centro-edit','Niterói','RJ') RETURNING id`)).rows[0].id;
    await db.pool.query(`UPDATE commerce.orders SET scheduled_delivery_date='2026-09-21',geo_resolution_id=$2 WHERE id=$1`,[f.id,location]);
    await db.pool.query(`UPDATE commerce.wholesale_stock SET quantity_on_hand=quantity_reserved WHERE environment='test'`);
    const before=await state(f),quote=await edit(f,{nova_modalidade:'pickup'});
    expect(quote).toMatchObject({previa:true,alterado:false,modalidade:'pickup',endereco_entrega:null,
      total_anterior:'188.00',total:'178.00',valor_frete:'0.00',
      retirada:{nome_loja:'Matriz',endereco:'Matriz, 1',maps_url:expect.stringContaining('-22.87,-42.99')}});
    expect(await state(f)).toEqual(before);
    expect((await edit(f,{confirmar_alteracao_id:quote.alteracao_id})).erro).toContain('aguarde');
    expect(await confirm(f,quote)).toMatchObject({ok:true,modalidade:'pickup',total:'178.00',valor_frete:'0.00'});
    const after=await state(f);
    expect(after.order).toMatchObject({fulfillment_mode:'pickup',delivery_address:null,total_amount:'178.00',
      geo_resolution_id:null,scheduled_delivery_date:null,unit_id:unit});
    expect(after.items).toEqual(before.items);expect(after.stock).toEqual(before.stock);expect(after.ledger).toEqual([]);
    expect(await edit(f,{confirmar_alteracao_id:quote.alteracao_id})).toMatchObject({ok:true,sem_alteracao:true});
    expect(await state(f)).toEqual(after);
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM audit.events
      WHERE entity_id=$1 AND event_type='bot_order_edit_applied'`,[f.id])).rows[0].n).toBe(1);
    await cancel({environment:'test',order_id:f.id,actor_label:'test',reason:'teste'},db.pool);
    expect((await state(f)).stock.every(s=>s.quantity_reserved===0)).toBe(true);
  });
  it('troca retirada por entrega com endereço preciso, frete calculado e a mesma unidade e reserva',async()=>{
    const f=await fixture();
    await db.pool.query(`UPDATE commerce.orders SET created_at=now()-interval '7 days' WHERE id=$1`,[f.id]);
    const before=await state(f);
    const quote=await edit(f,{nova_modalidade:'delivery',novo_endereco:'Rua Nova, 100, Centro, Niterói, RJ'});
    expect(quote).toMatchObject({previa:true,modalidade:'delivery',valor_frete:'19.00',total:'197.00'});
    expect(await state(f)).toEqual(before);
    expect(await confirm(f,quote)).toMatchObject({ok:true,modalidade:'delivery',total:'197.00'});
    const after=await state(f);
    expect(after.order).toMatchObject({fulfillment_mode:'delivery',delivery_address:'Rua Nova, 100, Centro, Niterói, RJ',unit_id:unit});
    expect((await db.pool.query(`SELECT scheduled_delivery_date=(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date+1 AS current_default
      FROM commerce.orders WHERE id=$1`,[f.id])).rows[0].current_default).toBe(true);
    expect(after.items).toEqual(before.items);expect(after.stock).toEqual(before.stock);expect(after.ledger).toEqual([]);
  });
  it('permite ida e volta de modalidade sem ressuscitar endereço e agendamento da entrega anterior',async()=>{
    const f=await fixture('delivery');
    expect(await confirm(f,await edit(f,{nova_modalidade:'pickup'}))).toMatchObject({ok:true});
    const before=await state(f);
    expect((await edit(f,{nova_modalidade:'delivery'})).erro).toBeTruthy();
    expect(await state(f)).toEqual(before);
    expect(await confirm(f,await edit(f,{nova_modalidade:'delivery',novo_endereco:'Rua Atual, 42, Niterói, RJ'})))
      .toMatchObject({ok:true,modalidade:'delivery',valor_frete:'19.00'});
    expect((await state(f)).stock).toEqual(before.stock);
  });
  it.each(['missing_address','stale_address','no_number','unknown','outside','route_failed','delivery_paused','pickup_disabled'])
  ('mantém pedido intacto quando a nova modalidade não é viável: %s',async kind=>{
    const pickup=kind==='pickup_disabled',f=await fixture(pickup?'delivery':'pickup');
    if(kind==='stale_address')await db.pool.query(`UPDATE commerce.orders SET delivery_address='Rua Antiga, 20, Niterói, RJ' WHERE id=$1`,[f.id]);
    const before=await state(f);
    if(kind==='unknown')geo.precise=false;
    if(kind==='outside')geo.km=60;
    if(kind==='route_failed')geo.road.mockResolvedValue(null);
    if(kind==='delivery_paused'||pickup)await db.pool.query(`UPDATE commerce.matriz_delivery_settings
      SET settings=jsonb_set(settings,$1::text[],'false') WHERE environment='test'`,[[pickup?'pickup_enabled':'delivery_enabled']]);
    const args:Record<string,unknown>={nova_modalidade:pickup?'pickup':'delivery'};
    if(!pickup&&!['missing_address','stale_address'].includes(kind))args.novo_endereco=kind==='no_number'?'Rua Nova, Centro, Niterói, RJ':'Rua Nova, 10, Niterói, RJ';
    expect((await edit(f,args)).erro).toBeTruthy();expect(await state(f)).toEqual(before);
  });
  it.each(['freight','coverage','pickup_disabled'])('revalida modalidade na confirmação: %s',async kind=>{
    const f=await fixture(kind==='pickup_disabled'?'delivery':'pickup');
    const quote=await edit(f,kind==='pickup_disabled'?{nova_modalidade:'pickup'}:
      {nova_modalidade:'delivery',novo_endereco:'Rua Nova, 10, Niterói, RJ'});
    expect(quote.previa).toBe(true);
    if(kind==='freight')geo.km=12;
    if(kind==='coverage')geo.km=60;
    if(kind==='pickup_disabled')await db.pool.query(`UPDATE commerce.matriz_delivery_settings
      SET settings=jsonb_set(settings,'{pickup_enabled}','false') WHERE environment='test'`);
    const before=await state(f);expect((await confirm(f,quote)).erro).toBeTruthy();expect(await state(f)).toEqual(before);
  });
  it.each(['paid','dispatched','arrived','service'])('bloqueia mudança se o atendimento avançar após a prévia: %s',async kind=>{
    const f=await fixture('delivery'),quote=await edit(f,{nova_modalidade:'pickup'});
    if(kind==='paid')await db.pool.query(`UPDATE commerce.orders SET status='paid' WHERE id=$1`,[f.id]);
    if(kind==='dispatched')await db.pool.query(`UPDATE commerce.orders SET delivery_status='dispatched',dispatched_at=now() WHERE id=$1`,[f.id]);
    if(kind==='arrived')await db.pool.query(`UPDATE commerce.orders SET pickup_arrived_at=now() WHERE id=$1`,[f.id]);
    if(kind==='service')await db.pool.query(`UPDATE commerce.orders SET pickup_services='[{"code":"mounting","quantity":1}]'::jsonb WHERE id=$1`,[f.id]);
    const before=await state(f);expect((await confirm(f,quote)).erro).toContain('humano');expect(await state(f)).toEqual(before);
  });
  it('rejeita modalidade inválida, endereço com retirada e combinação com remoção direta',async()=>{
    const f=await fixture('delivery'),before=await state(f);
    for(const args of [{nova_modalidade:'other'},{nova_modalidade:'pickup',novo_endereco:'Rua Nova, 2, Niterói, RJ'},
      {nova_modalidade:'pickup',remover_itens:[car]}]) {
      expect((await edit(f,args)).erro).toBeTruthy();expect(await state(f)).toEqual(before);
    }
  });
  it('desfaz mudança de modalidade, frete e reservas se a auditoria final falhar',async()=>{
    const f=await fixture('delivery'),quote=await edit(f,{nova_modalidade:'pickup',itens_finais:finalItems([moto,replacement])}),before=await state(f);
    await message(f.conversation,'agent_bot');await message(f.conversation);
    const c=await db.pool.connect(),wrapped={query:async(sql:string,args?:unknown[])=>{
      if(sql.startsWith('INSERT INTO audit.events')&&sql.includes("'bot_order_edit_applied'"))throw Error('Falha na auditoria');return c.query(sql,args);
    }} as PoolClient;
    try{expect((await edit(f,{confirmar_alteracao_id:quote.alteracao_id},f.conversation,'test',wrapped)).erro).toContain('Falha na auditoria');}
    finally{c.release();}
    expect(await state(f)).toEqual(before);
  });
  it('recota endereço pela estrada, sem alterar antes de confirmar e sem aceitar confirmação no mesmo turno',async()=>{
    const f=await fixture('delivery'),before=await state(f);
    const quote=await edit(f,{novo_endereco:'Praça Teste, 1, Centro, Itaboraí, RJ'});
    expect(quote).toMatchObject({previa:true,alterado:false,total_anterior:'188.00',total:'197.00',valor_frete:'19.00'});
    expect(geo.geocode).toHaveBeenCalledWith(expect.stringContaining('Itaboraí'),'test');
    expect(geo.road).toHaveBeenCalled();
    expect(await state(f)).toEqual(before);
    expect((await edit(f,{confirmar_alteracao_id:quote.alteracao_id})).erro).toContain('aguarde');
    expect(await confirm(f,quote)).toMatchObject({ok:true,total:'197.00',valor_frete:'19.00'});
    const after=await state(f);expect(after.order.delivery_address).toContain('Itaboraí');
    expect(after.stock).toEqual(before.stock);expect(after.ledger).toEqual([]);
  });
  it.each(['outside','unknown','paused','route_failed'])('não altera endereço se cobertura falhar: %s',async kind=>{
    const f=await fixture('delivery'),before=await state(f);
    if(kind==='outside')geo.km=60;
    if(kind==='unknown')geo.precise=false;
    if(kind==='route_failed')geo.road.mockResolvedValue(null);
    if(kind==='paused')await db.pool.query(`UPDATE commerce.matriz_delivery_settings SET settings=jsonb_set(settings,'{delivery_enabled}','false') WHERE environment='test'`);
    expect((await edit(f,{novo_endereco:'Rua Nova, 2, Itaboraí, RJ'})).erro).toBeTruthy();
    expect(await state(f)).toEqual(before);
  });
  it('inclui outro pneu, congela custo/preço e não duplica em repetição',async()=>{
    const f=await fixture(),before=await state(f),quote=await edit(f,{itens_finais:finalItems([car,moto,replacement])});
    expect(quote).toMatchObject({previa:true,total:'278.00'});expect(await state(f)).toEqual(before);
    expect(await confirm(f,quote)).toMatchObject({ok:true,total:'278.00'});
    const after=await state(f);
    expect(after.items.find(i=>i.product_id===replacement)).toMatchObject({quantity:1,unit_price:'100.00',matriz_unit_cost:'20.000000'});
    expect(after.stock.find(s=>s.measure==='130/70-13').quantity_reserved).toBe(1);
    expect(await edit(f,{confirmar_alteracao_id:quote.alteracao_id})).toMatchObject({ok:true,sem_alteracao:true});
    expect(await state(f)).toEqual(after);
  });
  it('troca pneu e libera o antigo; cancelamento libera somente os novos itens',async()=>{
    const f=await fixture(),quote=await edit(f,{itens_finais:finalItems([moto,replacement])});
    expect(await confirm(f,quote)).toMatchObject({ok:true,total:'189.00'});
    let after=await state(f);
    expect(after.items.map(i=>i.product_id).sort()).toEqual([moto,replacement].sort());
    expect(after.stock.find(s=>s.measure==='175/65-14').quantity_reserved).toBe(0);
    await cancel({environment:'test',order_id:f.id,actor_label:'test',reason:'teste'},db.pool);
    after=await state(f);expect(after.stock.every(s=>s.quantity_reserved===0&&s.quantity_on_hand===5)).toBe(true);
    expect(after.ledger).toEqual([]);
  });
  it('aumenta e reduz quantidade final; conclusão baixa somente a quantidade final',async()=>{
    const f=await fixture();
    let quote=await edit(f,{itens_finais:[{product_id:car,quantidade:1},{product_id:moto,quantidade:3}]});
    expect(await confirm(f,quote)).toMatchObject({ok:true,total:'356.00'});
    expect((await state(f)).stock.find(s=>s.measure==='90/90-12').quantity_reserved).toBe(3);
    quote=await edit(f,{itens_finais:[{product_id:car,quantidade:1},{product_id:moto,quantidade:2}]});
    expect(await confirm(f,quote)).toMatchObject({ok:true,total:'267.00'});
    await complete({environment:'test',order_id:f.id,actor_label:'test',payment_method:'pix'},db.pool);
    const after=await state(f);
    expect(after.stock.find(s=>s.measure==='90/90-12')).toMatchObject({quantity_on_hand:3,quantity_reserved:0});
    expect(after.ledger).toEqual([{source_type:'commerce.order.cogs',amount:'84.00'},{source_type:'commerce.order.revenue',amount:'267.00'}]);
  });
  it('usa a reserva própria sem consumir reservas de outros clientes',async()=>{
    const f=await fixture();
    await db.pool.query(`UPDATE commerce.wholesale_stock SET quantity_reserved=5 WHERE environment='test' AND measure='90/90-12'`);
    const before=await state(f);
    expect((await edit(f,{itens_finais:[{product_id:moto,quantidade:2}]})).estoque_insuficiente).toBe(true);
    expect(await state(f)).toEqual(before);
    const quote=await edit(f,{itens_finais:[{product_id:moto,quantidade:1}]});
    expect(await confirm(f,quote)).toMatchObject({ok:true,total:'89.00'});
  });
  it('recusa preço, frete ou estoque alterado após a prévia sem mexer no pedido',async()=>{
    const f=await fixture('delivery');
    let quote=await edit(f,{itens_finais:finalItems([moto,replacement]),novo_endereco:'Rua Nova, 1, Itaboraí, RJ'});
    await db.pool.query(`UPDATE commerce.matriz_product_prices SET price_amount=120 WHERE product_id=$1`,[replacement]);
    let before=await state(f);expect((await confirm(f,quote)).erro).toContain('Preço ou frete');expect(await state(f)).toEqual(before);
    quote=await edit(f,{novo_endereco:'Rua Nova, 1, Itaboraí, RJ'});geo.km=12;
    before=await state(f);expect((await confirm(f,quote)).erro).toContain('Preço ou frete');expect(await state(f)).toEqual(before);
    quote=await edit(f,{itens_finais:finalItems([moto,replacement])});
    await db.pool.query(`UPDATE commerce.wholesale_stock SET quantity_reserved=5 WHERE measure='130/70-13' AND environment='test'`);
    before=await state(f);expect((await confirm(f,quote)).estoque_insuficiente).toBe(true);expect(await state(f)).toEqual(before);
  });
  it('recusa proposta antiga quando o pedido ou outra prévia mudou',async()=>{
    const f=await fixture(),quote=await edit(f,{itens_finais:finalItems([moto,replacement])});
    await edit(f,{itens_finais:finalItems([car,replacement])});
    expect((await confirm(f,quote)).erro).toContain('última prévia');
    const newest=await edit(f,{itens_finais:finalItems([moto,replacement])});
    await db.pool.query(`UPDATE commerce.orders SET payment_method='dinheiro',updated_at=clock_timestamp() WHERE id=$1`,[f.id]);
    const before=await state(f);expect((await confirm(f,newest)).erro).toContain('Pedido mudou');expect(await state(f)).toEqual(before);
  });
  it('bloqueia outro contato, outro ambiente e token de outra conversa',async()=>{
    const f=await fixture(),quote=await edit(f,{itens_finais:finalItems([moto,replacement])}),before=await state(f);
    expect((await edit(f,{itens_finais:finalItems([moto])},randomUUID())).erro).toContain('não encontrado');
    expect((await edit(f,{itens_finais:finalItems([moto])},f.conversation,'prod')).erro).toContain('não encontrado');
    expect((await edit(f,{confirmar_alteracao_id:randomUUID()})).erro).toContain('Prévia não encontrada');
    expect(quote.alteracao_id).toBeTruthy();expect(await state(f)).toEqual(before);
  });
  it('não altera pedido com atendimento iniciado, nem aplica prévia após pagamento',async()=>{
    const f=await fixture(),quote=await edit(f,{itens_finais:finalItems([moto,replacement])});
    await db.pool.query('UPDATE commerce.orders SET pickup_arrived_at=now() WHERE id=$1',[f.id]);
    expect((await confirm(f,quote)).erro).toContain('atendente humano');
    await complete({environment:'test',order_id:f.id,actor_label:'test',payment_method:'pix'},db.pool);
    const before=await state(f);expect((await confirm(f,quote)).erro).toContain('atendente humano');expect(await state(f)).toEqual(before);
  });
  it('desfaz reservas, itens e total se falhar a gravação final',async()=>{
    const f=await fixture(),quote=await edit(f,{itens_finais:finalItems([moto,replacement])}),before=await state(f);
    await message(f.conversation,'agent_bot');await message(f.conversation);
    const c=await db.pool.connect(),wrapped={query:async(sql:string,args?:unknown[])=>{
      if(sql.startsWith('UPDATE commerce.orders SET total_amount'))throw Error('Falha simulada');return c.query(sql,args);
    }} as PoolClient;
    try{expect((await edit(f,{confirmar_alteracao_id:quote.alteracao_id},f.conversation,'test',wrapped)).erro).toContain('Falha simulada');}
    finally{c.release();}
    expect(await state(f)).toEqual(before);
  });
  it('valida quantidade, lista vazia, duplicação e preço enviado pelo modelo',async()=>{
    const f=await fixture(),before=await state(f);
    for(const itens_finais of [[],[{product_id:moto,quantidade:0}],[{product_id:moto,quantidade:1.5}],
      [{product_id:moto,quantidade:1,preco_unitario:1}],finalItems([moto,moto])]) {
      expect((await edit(f,{itens_finais})).erro).toBeTruthy();
    }
    expect(await state(f)).toEqual(before);
  });
  it('aceita confirmação em mensagens separadas e timestamps de segundos do Chatwoot',async()=>{
    const f=await fixture(),quote=await edit(f,{nova_forma_pagamento:'dinheiro'});
    await message(f.conversation,'agent_bot','Fica R$ 178 em dinheiro. Posso atualizar?');
    await message(f.conversation,'contact','Sim');
    await message(f.conversation,'contact','Pode atualizar');
    await db.pool.query(`UPDATE core.messages SET sent_at=date_trunc('second',sent_at) WHERE conversation_id=$1`,[f.conversation]);
    expect(await edit(f,{confirmar_alteracao_id:quote.alteracao_id})).toMatchObject({ok:true,forma_pagamento:'dinheiro',total:'178.00'});
  });
  it('prévia vencida mantém pedido e reserva originais',async()=>{
    const f=await fixture(),quote=await edit(f,{itens_finais:finalItems([moto,replacement])}),before=await state(f);
    const now=vi.spyOn(Date,'now').mockReturnValue(Date.now()+11*60_000);
    try{expect((await confirm(f,quote)).erro).toContain('vencida');}
    finally{now.mockRestore();}
    expect(await state(f)).toEqual(before);
  });
  it('não confirma proposta por outra conversa do mesmo cliente',async()=>{
    const f=await fixture(),quote=await edit(f,{itens_finais:finalItems([moto,replacement])}),before=await state(f);
    const other=(await db.pool.query(`INSERT INTO core.conversations(environment,chatwoot_conversation_id,chatwoot_account_id,
      contact_id,current_status,started_at) SELECT environment,$2,1,contact_id,'open',now() FROM commerce.orders WHERE id=$1 RETURNING id`,[f.id,++seq])).rows[0].id;
    await message(other,'agent_bot');await message(other);
    expect((await edit(f,{confirmar_alteracao_id:quote.alteracao_id},other)).erro).toContain('Prévia não encontrada');
    expect(await state(f)).toEqual(before);
  });
  it('não usa pneus meia-vida para cobrir quantidade pedida de pneus novos',async()=>{
    const f=await fixture(),before=await state(f);
    const alias=(await db.pool.query(`INSERT INTO commerce.products(environment,product_code,product_name,product_type,brand,tire_condition)
      VALUES('test','EDIT-NEW-TIRE','Pneu novo 90/90-12','tire','Pirelli','novo') RETURNING id`)).rows[0].id;
    await db.pool.query(`INSERT INTO commerce.tire_specs(environment,product_id,tire_size) VALUES('test',$1,'90/90-12')`,[alias]);
    await db.pool.query(`INSERT INTO commerce.matriz_product_prices(environment,product_id,price_amount) VALUES('test',$1,89)`,[alias]);
    expect((await edit(f,{itens_finais:[{product_id:moto,quantidade:1},{product_id:alias,quantidade:1}]})).erro).toBeTruthy();
    expect(await state(f)).toEqual(before);
    await db.pool.query(`INSERT INTO commerce.wholesale_stock(environment,measure,brand,tire_condition,quantity_on_hand,unit_cost)
      VALUES('test','90/90-12','Pirelli','novo',2,20)`);
    const quote=await edit(f,{itens_finais:[{product_id:moto,quantidade:3},{product_id:alias,quantidade:2}]});
    expect(await confirm(f,quote)).toMatchObject({ok:true,total:'445.00'});
    const rows=(await db.pool.query(`SELECT tire_condition,quantity_reserved FROM commerce.wholesale_stock
      WHERE environment='test' AND measure='90/90-12' ORDER BY tire_condition`)).rows;
    expect(rows).toEqual([{tire_condition:'meia_vida',quantity_reserved:3},{tire_condition:'novo',quantity_reserved:2}]);
  });
  it('remoção direta continua funcionando depois de adicionar produto, sem reconfirmação',async()=>{
    const f=await fixture(),quote=await edit(f,{itens_finais:finalItems([car,moto,replacement])});
    expect(await confirm(f,quote)).toMatchObject({ok:true});
    expect(await edit(f,{remover_itens:[car]})).toMatchObject({ok:true,total:'189.00'});
    expect((await state(f)).stock.find(s=>s.measure==='175/65-14').quantity_reserved).toBe(0);
    await cancel({environment:'test',order_id:f.id,actor_label:'test',reason:'teste'},db.pool);
    expect((await state(f)).stock.every(s=>s.quantity_reserved===0)).toBe(true);
  });
  it('preserva custo anterior e pondera apenas as unidades adicionadas',async()=>{
    const f=await fixture();
    await db.pool.query(`UPDATE commerce.wholesale_stock SET unit_cost=18 WHERE environment='test' AND measure='90/90-12'`);
    const quote=await edit(f,{itens_finais:[{product_id:car,quantidade:1},{product_id:moto,quantidade:3}]});
    expect(await confirm(f,quote)).toMatchObject({ok:true,total:'356.00'});
    expect((await state(f)).items.find(i=>i.product_id===moto).matriz_unit_cost).toBe('16.000000');
    await complete({environment:'test',order_id:f.id,actor_label:'test',payment_method:'pix'},db.pool);
    expect((await state(f)).ledger).toContainEqual({source_type:'commerce.order.cogs',amount:'108.00'});
  });
});

import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
vi.hoisted(()=>Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgres://test',
  DATABASE_SSL:'false',CHATWOOT_HMAC_SECRET:'unit-test',ADMIN_AUTH_TOKEN:'unit-test'}));
vi.mock('../../../src/parceiro/queries.js', () => ({ upsertPartnerCustomerWithClient: vi.fn() }));
import { executeTool } from '../../../src/atendente-v2/tools.js';
import { materializePartnerOrder } from '../../../src/atendente-v2/fulfillment.js';

const retrieved = new Date('2026-10-12T03:48:54Z');
function order(overrides: Record<string, unknown> = {}) {
  return { id:'order',order_number:'PED-0026',status:'open',total_amount:'55.00',fulfillment_mode:'pickup',
    payment_method:'A receber',delivery_address:null,customer_name:'Cliente fictício',created_at:new Date('2026-10-12T03:48:00Z'),closed_at:null,
    partner_order_id:'partner-order',partner_delivery_status:'pending',partner_status:'paid',
    partner_payment_method:'pix',partner_awaiting_pickup:false,partner_retrieved_at:retrieved,partner_delivered_at:null,...overrides };
}
async function consult(row: ReturnType<typeof order>, args: Record<string,unknown>={order_number:'PED-0026'}) {
  const query=vi.fn(async(sql:string)=>{
    if(sql.includes('FROM core.conversations'))return {rows:[{contact_id:'contact'}]};
    if(sql.includes('FROM commerce.order_items'))return {rows:[]};
    if(sql.includes('FROM commerce.orders'))return {rows:[row]};
    throw Error('Consulta inesperada: '+sql);
  });
  return {out:JSON.parse(await executeTool({query} as unknown as PoolClient,'test','conversation','consultar_pedido',args)),query};
}
describe('estado real do pedido do parceiro no bot',()=>{
  it.each([{order_number:'PED-0026'},{}])('reconhece retirada na busca por número e na lista: %j',async args=>{
    const {out}=await consult(order(),args);
    expect(out.pedidos[0]).toMatchObject({status:'paid',situacao_parceiro:'retirado',pagamento:'pix',fechado_em:retrieved.toISOString()});
  });
  it('reserva pendente informa aguardando retirada, sem declarar que foi retirado',async()=>{
    const {out}=await consult(order({partner_status:'confirmed',partner_awaiting_pickup:true,partner_retrieved_at:null}));
    expect(out.pedidos[0]).toMatchObject({status:'confirmed',situacao_parceiro:'aguardando retirada',fechado_em:null});
  });
  it('pagamento sozinho não comprova que o cliente retirou',async()=>{
    const {out}=await consult(order({partner_retrieved_at:null}));
    expect(out.pedidos[0].situacao_parceiro).not.toBe('retirado');
  });
  it('cancelamento prevalece sobre uma data de retirada antiga',async()=>{
    const {out}=await consult(order({partner_status:'cancelled'}));
    expect(out.pedidos[0]).toMatchObject({status:'cancelled',situacao_parceiro:'cancelado'});
  });
  it.each([['pending','em separação'],['dispatched','saiu para entrega'],['delivered','entregue'],['failed','entrega não concluída']])(
    'mantém a entrega %s como %s',async(status,text)=>{
      const {out}=await consult(order({fulfillment_mode:'delivery',partner_status:'confirmed',partner_retrieved_at:null,partner_delivery_status:status}));
      expect(out.pedidos[0].situacao_parceiro).toBe(text);
    });
  it('pedido da Matriz preserva seu estado e pagamento',async()=>{
    const {out}=await consult(order({partner_order_id:null,payment_method:'dinheiro'}));
    expect(out.pedidos[0]).toMatchObject({status:'open',pagamento:'dinheiro',fechado_em:null});
    expect(out.pedidos[0]).not.toHaveProperty('situacao_parceiro');
  });
});
describe('forma combinada na criação do parceiro',()=>{
  it.each(['pix','dinheiro','credito'])('preserva %s no pedido reservado',async method=>{
    const query=vi.fn(async(sql:string)=>{
      if(sql.includes('FROM commerce.partner_stock_levels'))return {rows:[{id:'stock',sale_price:'55.00'}]};
      if(sql.includes('register_partner_local_order'))return {rows:[{id:'partner-order'}]};
      if(sql.includes('FROM commerce.partner_orders'))return {rows:[{total_amount:'55.00',customer_name:'Cliente fictício'}]};
      return {rows:[],rowCount:1};
    });
    await materializePartnerOrder({query} as unknown as PoolClient,{environment:'test',unitId:'unit',slug:'fixture'} as never,
      {customer_name:'Cliente fictício',customer_phone:null,items:[{partner_stock_id:'stock',quantity:1,unit_price:55}],
        payment_method:method,fulfillment_mode:'pickup',delivery_address:null,freight_amount:0,idempotency_key:'fixture-key',reserve_for_pickup:true} as never);
    const creation=query.mock.calls.find(call=>call[0].includes('register_partner_local_order'));
    expect((creation as unknown as [string,unknown[]])[1][5]).toBe(method);
  });
});

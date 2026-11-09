import Fastify from 'fastify';
import { beforeEach, expect, it, vi } from 'vitest';
const m=vi.hoisted(()=>({owner:true,search:vi.fn(),write:vi.fn()}));
vi.mock('../../../src/admin/auth.js',()=>({getAdminContext:()=>({collaboratorId:null}),
  requireAdminOwner:async(_:any,r:any)=>{if(!m.owner)return r.code(403).send({error:'owner_required'});}}));
vi.mock('../../../src/shared/config/env.js',()=>({env:{FAREJADOR_ENV:'test'}}));
vi.mock('../../../src/shared/logger.js',()=>({logger:{error:vi.fn()}}));
vi.mock('../../../src/admin/painel/sale-customers.js',()=>({searchSaleCustomers:m.search}));
vi.mock('../../../src/admin/painel/queries.js',()=>({registerWalkinOrder:m.write,registerManualOrder:vi.fn(),
  cancelManualOrder:vi.fn(),completeMatrizPickup:vi.fn(),getMatrizRetiradas:vi.fn(),updateMatrizPickupStage:vi.fn()}));
vi.mock('../../../src/admin/painel/route-helpers.js',()=>({operatorLabel:()=> 'owner:session',mapWriteError:()=>({status:400,error:'invalid'})}));
import { registerPainelPedidos } from '../../../src/admin/painel/route-pedidos.js';
beforeEach(()=>{vi.clearAllMocks();m.owner=true;});
it('busca exige proprietário, limita entrada e usa ambiente do servidor',async()=>{
  const app=Fastify();await registerPainelPedidos(app);
  try{
    m.owner=false;expect((await app.inject('/admin/api/orders/customer-search?q=Maria')).statusCode).toBe(403);
    expect(m.search).not.toHaveBeenCalled();m.owner=true;
    for(const q of ['M','x'.repeat(101)])expect((await app.inject('/admin/api/orders/customer-search?q='+q)).statusCode).toBe(400);
    m.search.mockResolvedValue({rows:[]});
    const response=await app.inject('/admin/api/orders/customer-search?q=Maria&environment=prod');
    expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toBe('private, no-store');
    expect(m.search).toHaveBeenCalledWith('test','Maria');
  }finally{await app.close();}
});
it('venda transmite referência validada e ignora ator e ambiente enviados',async()=>{
  const app=Fastify();await registerPainelPedidos(app);
  const body={customer_mode:'existing',customer_ref:{source:'balcao',id:crypto.randomUUID()},
    items:[{product_id:crypto.randomUUID(),quantity:1,unit_price:120}],payment_method:'Pix',fulfillment_mode:'pickup',
    source_tag:'walkin_balcao',idempotency_key:crypto.randomUUID(),environment:'prod',actor_label:'forged'};
  try{
    m.write.mockResolvedValue({order_id:'order'});
    expect((await app.inject({method:'POST',url:'/admin/api/orders/register-walkin',payload:body})).statusCode).toBe(200);
    expect(m.write).toHaveBeenCalledWith(expect.objectContaining({customer_ref:body.customer_ref,environment:'test',actor_label:'owner:session'}));
    expect((await app.inject({method:'POST',url:'/admin/api/orders/register-walkin',payload:{...body,customer_ref:{...body.customer_ref,source:'parceiro'}}})).statusCode).toBe(400);
  }finally{await app.close();}
});

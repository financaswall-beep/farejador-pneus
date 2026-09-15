import Fastify from 'fastify';
import {randomUUID} from 'node:crypto';
import {beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({owner:true,ready:vi.fn(),history:vi.fn(),lots:vi.fn(),save:vi.fn(),cancel:vi.fn()}));
vi.mock('../../../src/admin/auth.js',()=>({requireAdminAuth:async()=>undefined,
 requireAdminOwner:async(_request:unknown,reply:any)=>{if(!m.owner)return reply.code(403).send({error:'admin_owner_required'});},
 getAdminContext:()=>({collaboratorId:null})}));
vi.mock('../../../src/admin/painel/route-helpers.js',()=>({operatorLabel:()=> 'owner:qa',mapWriteError:()=>({status:500,error:'internal_error'})}));
vi.mock('../../../src/admin/painel/queries-lot-sales.js',()=>({lotSalesReady:m.ready,listLotSales:m.history,listSaleLots:m.lots}));
vi.mock('../../../src/admin/painel/register-lot-sale.js',()=>({registerLotSale:m.save}));
vi.mock('../../../src/admin/painel/queries-atacado-cancelar.js',()=>({cancelWholesaleSale:m.cancel}));
vi.mock('../../../src/shared/config/env.js',()=>({env:{WHOLESALE_FINANCE:true,MATRIZ_CENTRAL_LEDGER:true}}));
import {registerLotSaleRoutes} from '../../../src/admin/painel/route-lot-sales.js';
beforeEach(()=>{vi.clearAllMocks();m.owner=true;m.ready.mockResolvedValue(true);m.history.mockResolvedValue({rows:[],total:0});m.lots.mockResolvedValue([]);});
const body=()=>({new_customer:{name:'Cliente QA'},description:'Lote',sold_on:'2026-09-15',amount:100,expected_cost:50,
 payment_status:'paid',payment_method:'Pix',idempotency_key:randomUUID(),allocations:[{lot_id:randomUUID(),quantity:10}]});
it('bloqueia escrita de não-owner antes de consultar ou alterar o banco',async()=>{
 const app=Fastify();await registerLotSaleRoutes(app);m.owner=false;
 expect((await app.inject({method:'POST',url:'/admin/api/wholesale/lot-sales',payload:body()})).statusCode).toBe(403);
 expect((await app.inject({method:'POST',url:'/admin/api/wholesale/lot-sales/'+randomUUID()+'/cancel',payload:{reason:'Cliente desistiu',idempotency_key:randomUUID()}})).statusCode).toBe(403);
 expect(m.ready).not.toHaveBeenCalled();expect(m.save).not.toHaveBeenCalled();expect(m.cancel).not.toHaveBeenCalled();await app.close();
});
it('mostra atualização pendente e não tenta ler tabelas novas nem confirmar antes da migração',async()=>{
 const app=Fastify();await registerLotSaleRoutes(app);m.ready.mockResolvedValue(false);
 const read=await app.inject('/admin/api/wholesale/lot-sales');expect(read.statusCode).toBe(200);expect(read.json().ready).toBe(false);expect(m.history).not.toHaveBeenCalled();
 expect((await app.inject({method:'POST',url:'/admin/api/wholesale/lot-sales',payload:body()})).statusCode).toBe(503);expect(m.save).not.toHaveBeenCalled();await app.close();
});
it('rejeita catálogo no corpo e informa conflito de saldo, preservando dados validados na confirmação',async()=>{
 const app=Fastify();await registerLotSaleRoutes(app);
 expect((await app.inject({method:'POST',url:'/admin/api/wholesale/lot-sales',payload:{...body(),items:[]}})).statusCode).toBe(400);expect(m.save).not.toHaveBeenCalled();
 m.save.mockRejectedValueOnce(new Error('lot_sale_stock_changed'));
 const conflict=await app.inject({method:'POST',url:'/admin/api/wholesale/lot-sales',payload:body()});expect(conflict.statusCode).toBe(409);expect(conflict.json().error).toBe('lot_sale_stock_changed');
 m.save.mockResolvedValueOnce({order_id:randomUUID()});const input=body();expect((await app.inject({method:'POST',url:'/admin/api/wholesale/lot-sales',payload:input})).statusCode).toBe(201);
 expect(m.save.mock.calls[1][0]).toMatchObject(input);expect(m.save.mock.calls[1][1]).toBe('owner:qa');await app.close();
});

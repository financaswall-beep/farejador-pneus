import Fastify from 'fastify';
import {randomUUID} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({submit:vi.fn(),read:vi.fn(),receive:vi.fn(),ctx:{partnerUnitId:'own',environment:'test'}}));
vi.mock('../../../src/parceiro/auth.js',()=>({
  requirePartnerAuth:async(req:any,reply:any)=>{if(!req.headers.authorization)return reply.code(401).send({error:'unauthorized'});},
  requireScreen:(screen:string)=>async(req:any,reply:any)=>{
    if(req.headers.authorization==='no-'+screen)return reply.code(403).send({error:'forbidden'});
  },getPartnerContext:()=>mocks.ctx,
}));
vi.mock('../../../src/parceiro/operation-buy-catalog.js',()=>({getPartnerBuyCatalog:vi.fn()}));
vi.mock('../../../src/parceiro/operation-buy-requests.js',()=>({submitBuyRequest:mocks.submit,getBuyRequests:mocks.read,receiveBuyRequest:mocks.receive}));
vi.mock('../../../src/parceiro/route-buy-request-errors.js',()=>({buyRequestError:(error:Error)=>({status:409,error:error.message})}));
import {registerPartnerBuyCatalogRoutes} from '../../../src/parceiro/route-operation-buy-catalog.js';
const input={idempotency_key:randomUUID(),items:[{offer_key:randomUUID(),quantity:2,expected_price_cents:6500}]};
describe('rotas de pedido e recebimento do parceiro',()=>{
  it('exige compras e estoque, não aceita unidade enviada pelo cliente e deriva contexto da sessão',async()=>{
    const app=Fastify();registerPartnerBuyCatalogRoutes(app,mocks.receive);
    const url='/parceiro/meier/api/operacao/comprar/pedidos';mocks.submit.mockResolvedValue({request_id:'id'});
    try{
      for(const auth of ['', 'no-compras','no-estoque']){
        const response=await app.inject({method:'POST',url,payload:input,headers:auth?{authorization:auth}:{}});
        expect(response.statusCode).toBe(auth?403:401);
      }
      expect((await app.inject({method:'POST',url,payload:{...input,partner_unit_id:randomUUID()},headers:{authorization:'owner'}})).statusCode).toBe(400);
      expect((await app.inject({method:'POST',url,payload:input,headers:{authorization:'owner'}})).statusCode).toBe(201);
      expect(mocks.submit).toHaveBeenCalledWith(mocks.ctx,input);
    }finally{await app.close();}
  });
  it('valida itens de recebimento e exige as mesmas permissões para gravar',async()=>{
    const app=Fastify();registerPartnerBuyCatalogRoutes(app,mocks.receive);const id=randomUUID(),url=`/parceiro/meier/api/operacao/comprar/pedidos/${id}/receber`;
    const payload={idempotency_key:randomUUID(),items:[{item_id:randomUUID(),received_quantity:1}]};mocks.receive.mockResolvedValue({received:true});
    try{
      expect((await app.inject({method:'POST',url,payload,headers:{authorization:'no-compras'}})).statusCode).toBe(403);
      expect((await app.inject({method:'POST',url,payload:{...payload,items:[{...payload.items[0],received_quantity:-1}]},headers:{authorization:'owner'}})).statusCode).toBe(400);
      expect((await app.inject({method:'POST',url,payload,headers:{authorization:'owner'}})).statusCode).toBe(200);
      expect(mocks.receive).toHaveBeenCalledWith(mocks.ctx,id,payload);
    }finally{await app.close();}
  });
});

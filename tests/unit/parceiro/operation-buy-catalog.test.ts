import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(() => ({ query:vi.fn(), context:vi.fn(), session:{partnerUnitId:'own-unit',slug:'meier'} }));
vi.mock('../../../src/parceiro/db.js', () => ({withPartnerContext:mocks.context}));
vi.mock('../../../src/parceiro/auth.js', () => ({
  requirePartnerAuth:async (req:any,reply:any) => {
    if (!req.headers.authorization) return reply.code(401).send({error:'unauthorized'});
    if (req.params.slug!==mocks.session.slug) return reply.code(403).send({error:'wrong_unit'});
  },
  requireScreen:(module:string) => async (req:any,reply:any) => {
    expect(module).toBe('estoque');
    if (req.headers.authorization==='no-stock') return reply.code(403).send({error:'forbidden'});
  },
  getPartnerContext:() => mocks.session,
}));
import { getPartnerBuyCatalog } from '../../../src/parceiro/operation-buy-catalog.js';
import { registerPartnerBuyCatalogRoutes } from '../../../src/parceiro/route-operation-buy-catalog.js';

describe('Comprar — API somente de consulta', () => {
  it('projeta só campos públicos e usa o contexto da sessão para consultar', async () => {
    mocks.context.mockImplementation(async (_:string,fn:any) => fn({query:mocks.query}));
    mocks.query.mockResolvedValue({rows:[{offer_key:'product-1',measure:'90/90-18',brand:'Pirelli',tire_condition:'meia_vida',
      vehicle_type:'motorcycle',quantity_available:10,price_cents:'6500',unit_cost:40,retail_price:139}]});
    const result=await getPartnerBuyCatalog(mocks.session as any);
    expect(mocks.context).toHaveBeenCalledWith('own-unit',expect.any(Function));
    expect(result).toEqual({checkout_enabled:false,rows:[{offer_key:'product-1',measure:'90/90-18',brand:'Pirelli',
      tire_condition:'meia_vida',vehicle_type:'motorcycle',quantity_available:10,price_cents:6500}]});
  });
  it('exige sessão, slug próprio e acesso a estoque; resposta não fica em cache', async () => {
    const app=Fastify(); registerPartnerBuyCatalogRoutes(app);
    try {
      expect((await app.inject('/parceiro/meier/api/operacao/comprar')).statusCode).toBe(401);
      for (const [slug,authorization] of [['outro','owner'],['meier','no-stock']]) {
        expect((await app.inject({url:`/parceiro/${slug}/api/operacao/comprar`,headers:{authorization}})).statusCode).toBe(403);
      }
      const response=await app.inject({url:'/parceiro/meier/api/operacao/comprar',headers:{authorization:'owner'}});
      expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
      expect((await app.inject({method:'POST',url:'/parceiro/meier/api/operacao/comprar/pedidos',headers:{authorization:'owner'}})).statusCode).toBe(404);
    } finally { await app.close(); }
  });
});

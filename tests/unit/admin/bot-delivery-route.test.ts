import Fastify from 'fastify';
import { beforeEach,describe,expect,it,vi } from 'vitest';
const m=vi.hoisted(()=>({get:vi.fn(),save:vi.fn(),simulate:vi.fn(),owner:true}));
vi.mock('../../../src/admin/auth.js',()=>({requireAdminOwner:async(_request:unknown,reply:any)=>{if(!m.owner)return reply.code(403).send({error:'admin_owner_required'});}}));
vi.mock('../../../src/admin/painel/bot-delivery-config.js',()=>({getBotDeliveryConfig:m.get,saveBotDeliveryConfig:m.save}));
vi.mock('../../../src/admin/painel/bot-delivery-simulation.js',()=>({deliveryProducts:vi.fn(),geocodeDeliveryAddress:vi.fn(),simulateBotDelivery:m.simulate}));
vi.mock('../../../src/admin/painel/route-helpers.js',()=>({operatorLabel:()=> 'owner:test'}));
import { registerBotDeliveryRoutes } from '../../../src/admin/painel/route-bot-delivery.js';
const settings={delivery_enabled:true,pickup_enabled:true,radius_km:12,address:'Matriz teste',latitude:0,longitude:0,days:[],opens_at:null,closes_at:null,delivery_days:null};
beforeEach(()=>{vi.clearAllMocks();m.owner=true;});
describe('rotas de entrega',()=>{
  it('protege cadastro, busca, geocodificação e simulação com o mesmo acesso de proprietário',async()=>{
    const app=Fastify();await registerBotDeliveryRoutes(app);m.owner=false;
    for(const [method,url] of [['GET',''],['PUT',''],['GET','/produtos?q=130'],['POST','/localizar'],['POST','/simular']] as const){
      expect((await app.inject({method,url:'/admin/api/bot/entrega'+url})).statusCode).toBe(403);
    }
    expect(m.get).not.toHaveBeenCalled();expect(m.save).not.toHaveBeenCalled();expect(m.simulate).not.toHaveBeenCalled();await app.close();
  });
  it('rejeita raio ausente e retorna conflito sem fingir salvamento',async()=>{
    const app=Fastify();await registerBotDeliveryRoutes(app);
    expect((await app.inject({method:'PUT',url:'/admin/api/bot/entrega',payload:{expected_version:0,settings:{...settings,radius_km:null}}})).statusCode).toBe(400);
    expect(m.save).not.toHaveBeenCalled();m.save.mockRejectedValue(new Error('delivery_settings_conflict'));
    expect((await app.inject({method:'PUT',url:'/admin/api/bot/entrega',payload:{expected_version:2,settings}})).statusCode).toBe(409);
    expect(m.save).toHaveBeenCalledWith(settings,2,'owner:test');await app.close();
  });
  it('não permite simular pedido vazio',async()=>{
    const app=Fastify();await registerBotDeliveryRoutes(app);
    expect((await app.inject({method:'POST',url:'/admin/api/bot/entrega/simular',payload:{address:'Rua teste, 10',settings,items:[]}})).statusCode).toBe(400);
    expect(m.simulate).not.toHaveBeenCalled();await app.close();
  });
});

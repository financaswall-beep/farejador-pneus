import Fastify from 'fastify';
import { beforeEach,describe,expect,it,vi } from 'vitest';
const m=vi.hoisted(()=>({get:vi.fn(),save:vi.fn(),simulate:vi.fn(),owner:true}));
vi.mock('../../../src/admin/auth.js',()=>({requireAdminOwner:async(_request:unknown,reply:any)=>{if(!m.owner)return reply.code(403).send({error:'admin_owner_required'});}}));
vi.mock('../../../src/admin/painel/bot-delivery-config.js',()=>({getBotDeliveryConfig:m.get,saveBotDeliveryConfig:m.save}));
vi.mock('../../../src/admin/painel/bot-delivery-simulation.js',()=>({deliveryProducts:vi.fn(),geocodeDeliveryAddress:vi.fn(),simulateBotDelivery:m.simulate}));
vi.mock('../../../src/admin/painel/route-helpers.js',()=>({operatorLabel:()=> 'owner:test'}));
import { registerBotDeliveryRoutes } from '../../../src/admin/painel/route-bot-delivery.js';
import { DEFAULT_MATRIZ_FREIGHT } from '../../../src/atendente-v2/matriz-freight.js';
const settings={delivery_enabled:true,pickup_enabled:true,radius_km:12,address:'Matriz teste',latitude:0,longitude:0,days:[],opens_at:null,closes_at:null,delivery_days:null,freight:{...DEFAULT_MATRIZ_FREIGHT}};
beforeEach(()=>{vi.clearAllMocks();m.owner=true;});
describe('rotas de entrega',()=>{
  it('valida os 55 km e o frete antes de salvar, inclusive com a entrega pausada',async()=>{
    const app=Fastify();await registerBotDeliveryRoutes(app);
    m.save.mockResolvedValue({configured:true,version:1});
    const value={...settings,radius_km:55,freight:{...settings.freight,above_price_brl:29.5}};
    expect((await app.inject({method:'PUT',url:'/admin/api/bot/entrega',payload:{expected_version:0,settings:value}})).statusCode).toBe(200);
    expect(m.save).toHaveBeenCalledWith(value,0,'owner:test');m.save.mockClear();
    for(const invalid of [{...value,radius_km:56,delivery_enabled:false},{...value,freight:{...value.freight,first_price_brl:-1}}]){
      expect((await app.inject({method:'PUT',url:'/admin/api/bot/entrega',payload:{expected_version:1,settings:invalid}})).statusCode).toBe(400);
    }
    expect(m.save).not.toHaveBeenCalled();await app.close();
  });
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

import type { PoolClient } from 'pg';
import { beforeEach,describe,expect,it,vi } from 'vitest';
const mocks=vi.hoisted(()=>({ location:vi.fn(),city:vi.fn(),pin:vi.fn(),candidates:vi.fn(),distances:vi.fn(),settings:vi.fn() }));
vi.mock('../../../src/shared/config/env.js',()=>({env:{ROUTING_PROXIMITY_FIRST:true}}));
vi.mock('../../../src/atendente-v2/fulfillment.js',()=>({resolveUnitCandidates:mocks.candidates,resolveUnitCandidatesByProximity:mocks.candidates,
  resolveDistances:mocks.distances,resolveMunicipioFromBairro:mocks.city,normalizeRegion:(v:string)=>v.toLowerCase()}));
vi.mock('../../../src/atendente-v2/delivery-quote-routing.js',()=>({fillCityFromPin:mocks.pin}));
vi.mock('../../../src/atendente-v2/customer-location.js',()=>({resolveCustomerLocation:mocks.location}));
vi.mock('../../../src/atendente-v2/matriz-delivery-settings.js',()=>({readDeliverySettings:mocks.settings}));
import { consultStoreHours } from '../../../src/atendente-v2/store-hours-tool.js';
const hours=[{day:1,opens_at:'08:00',closes_at:'18:00'}];
const now=new Date('2026-10-05T12:00:00Z');
beforeEach(()=>{
  vi.clearAllMocks(); mocks.city.mockResolvedValue('Rio de Janeiro'); mocks.pin.mockResolvedValue({municipio:'Rio de Janeiro'});
  mocks.location.mockResolvedValue(null); mocks.settings.mockResolvedValue({settings:{pickup_enabled:true,latitude:-22,longitude:-43,store_hours:hours}});
  mocks.candidates.mockResolvedValue([
    {ctx:{unitId:'near',unitName:'Loja próxima'},serviceMode:'both',location:{lat:-22.1,lng:-43.1}},
    {ctx:{unitId:'far',unitName:'Loja distante'},serviceMode:'both',location:{lat:-22.2,lng:-43.2}},
  ]);
  mocks.distances.mockResolvedValue(new Map([['near',2],['far',10],['hours-matriz',20]]));
});
describe('bot consulta o horário da loja correta',()=>{
  it('pergunta localização antes de responder pela Matriz numa pergunta genérica',async()=>{
    const query=vi.fn(); const result=await consultStoreHours({query} as unknown as PoolClient,'test','conv',{},now);
    expect(result).toMatchObject({encontrado:false,precisa_localizacao:true});
    expect(query).not.toHaveBeenCalled(); expect(mocks.settings).not.toHaveBeenCalled();
  });
  it('Matriz explícita usa funcionamento presencial, não janela de entrega',async()=>{
    mocks.settings.mockResolvedValue({settings:{opens_at:'10:00',closes_at:'15:00',store_hours:hours}});
    const result=await consultStoreHours({query:vi.fn().mockResolvedValue({rows:[{content:'Até que horas a Matriz abre?'}]})} as unknown as PoolClient,'test','conv',{loja:'matriz'},now);
    expect(result).toMatchObject({nome_loja:'Matriz',horario_semanal:hours,status_agora:{state:'open',closes_at:'18:00'}});
    expect(mocks.location).not.toHaveBeenCalled();
  });
  it('não aceita Matriz escolhida pelo modelo sem o cliente ter mencionado essa loja',async()=>{
    const query=vi.fn().mockResolvedValue({rows:[{content:'Até que horas vocês abrem?'}]});
    const result=await consultStoreHours({query} as unknown as PoolClient,'test','conv',{loja:'matriz'},now);
    expect(result).toMatchObject({encontrado:false,precisa_localizacao:true});
    expect(mocks.settings).not.toHaveBeenCalled();
  });
  it('seleciona a próxima e calcula seu horário sem consultar estoque ou preço',async()=>{
    mocks.location.mockResolvedValue({lat:-22.1,lng:-43.1});
    const query=vi.fn().mockResolvedValue({rows:[{hours,legacy_text:'antigo'}]});
    const result=await consultStoreHours({query} as unknown as PoolClient,'test','conv',{},now);
    expect(result).toMatchObject({nome_loja:'Loja próxima',tipo_loja:'parceiro',status_agora:{state:'open'},distancia_km:2});
    expect(query.mock.calls[0][1]).toEqual(['test','near']);
    expect(query.mock.calls.every(([sql])=>sql.startsWith('SELECT')&&!/stock|price|INSERT|UPDATE/.test(sql))).toBe(true);
  });
  it('loja fechada continua identificada corretamente, sem emprestar horário de outra',async()=>{
    mocks.location.mockResolvedValue({lat:-22.1,lng:-43.1});
    const query=vi.fn().mockResolvedValue({rows:[{hours:[],legacy_text:'fechada'}]});
    const result=await consultStoreHours({query} as unknown as PoolClient,'test','conv',{},now);
    expect(result).toMatchObject({nome_loja:'Loja próxima',status_agora:{state:'closed',next_opening:null}});
  });
  it('texto antigo sem grade não permite afirmar que está aberta agora',async()=>{
    mocks.location.mockResolvedValue({lat:-22.1,lng:-43.1});
    const query=vi.fn().mockResolvedValue({rows:[{hours:null,legacy_text:'Segunda a sábado das 8h às 18h'}]});
    const result=await consultStoreHours({query} as unknown as PoolClient,'test','conv',{},now);
    expect(result).toMatchObject({nome_loja:'Loja próxima',horario_semanal:null,status_agora:{state:'unknown'}});
  });
});

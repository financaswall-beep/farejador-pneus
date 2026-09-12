import type { PoolClient } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ pin: vi.fn(), config: {
  FAREJADOR_ENV:'test', DATABASE_URL:'postgresql://test:test@localhost:5432/test',
  PARTNER_DATABASE_URL:'postgresql://test:test@localhost:5432/test', DATABASE_SSL:false, LOCATION_FRESHNESS_HOURS:24,
} }));
vi.mock('../../../src/shared/config/env.js', () => ({ env:mocks.config }));
vi.mock('../../../src/atendente-v2/delivery-quote-routing.js', () => ({ fillCityFromPin:mocks.pin }));
import { prepareToolLocation } from '../../../src/atendente-v2/tool-location.js';
import { AmbiguousNeighborhoodError, chooseNeighborhoodCity, type NeighborhoodCandidate } from '../../../src/atendente-v2/neighborhood-resolution.js';
import { executeTool } from '../../../src/atendente-v2/tools.js';

const candidates:NeighborhoodCandidate[] = ['Rio de Janeiro','Maricá'].map(city_name => ({city_name,neighborhood_canonical:'flamengo',city_resolution_priority:0}));
function database(options: { rows?:NeighborhoodCandidate[]; memory?:Record<string,unknown>; geo?:string } = {}) {
  const query = vi.fn(async (sql:string) => {
    if(sql.includes('FROM analytics.conversation_facts')) return {rows:options.memory?[options.memory]:[]};
    if(sql.includes('WHERE environment=$1 AND id=$2')) return {rows:options.geo?[{city_name:options.geo}]:[]};
    if(sql.includes('FROM commerce.geo_resolutions')) return {rows:options.rows??candidates};
    throw Error('Não deve consultar estoque, frete ou gravar pedido antes da cidade: '+sql);
  });
  return {query,client:{query} as unknown as PoolClient};
}
beforeEach(()=>{mocks.pin.mockReset().mockResolvedValue({municipio:null,neighborhoodCanonical:null});});

describe('confirmação pontual da cidade do bairro',()=>{
  it.each(['buscar_produto','buscar_compatibilidade','calcular_frete','localizacao_loja','pedir_foto','criar_pedido'])(
    '%s interrompe antes das operações comerciais e retorna somente a dúvida geográfica',async tool=>{
      const {client,query}=database();
      const result=JSON.parse(await executeTool(client,'test','conv',tool,{bairro:'Flamengo',medida_pneu:'130/70-13'}));
      expect(result).toMatchObject({erro:'municipio_ambiguo',precisa_municipio:true,bairro:'Flamengo',municipios_possiveis:['Maricá','Rio de Janeiro']});
      expect(result).not.toHaveProperty('produtos');
      expect(result).not.toHaveProperty('valor');
      expect(query.mock.calls.every(([sql])=>sql.trim().startsWith('SELECT'))).toBe(true);
    });

  it('após a resposta da cidade, mantém o pneu e o bairro sem consultar outra localização',async()=>{
    const {client,query}=database();
    const args={bairro:'Flamengo',municipio:'Maricá',medida_pneu:'130/70-13'};
    expect(await prepareToolLocation(client,'test','conv','buscar_produto',args)).toEqual(args);
    expect(query).not.toHaveBeenCalled();
    expect(mocks.pin).not.toHaveBeenCalled();
  });

  it('resolve cidade única sem perguntar nem consultar Google ou memória',async()=>{
    const {client,query}=database({rows:[{city_name:'Niterói',neighborhood_canonical:'icarai',city_resolution_priority:0}]});
    expect(await prepareToolLocation(client,'test','conv','buscar_produto',{bairro:'Icaraí'})).toEqual({bairro:'Icaraí',municipio:'Niterói'});
    expect(query).toHaveBeenCalledTimes(1);
    expect(mocks.pin).not.toHaveBeenCalled();
  });

  it('usa o município do pino para um bairro ambíguo, sem consultar memória',async()=>{
    mocks.pin.mockResolvedValue({municipio:'Maricá',neighborhoodCanonical:'flamengo'});
    const {client,query}=database();
    expect(await prepareToolLocation(client,'test','conv','buscar_produto',{bairro:'Flamengo'})).toEqual({bairro:'Flamengo',municipio:'Maricá'});
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('aproveita cidade realmente escrita na última localização da mesma conversa',async()=>{
    const {client,query}=database({memory:{municipality:'Maricá',neighborhood:'Flamengo',content:'Flamengo, Marica'}});
    expect(await prepareToolLocation(client,'test','conv','buscar_produto',{bairro:'Flamengo'})).toEqual({bairro:'Flamengo',municipio:'Maricá'});
    expect(query.mock.calls.find(([sql])=>sql.includes('analytics.conversation_facts'))).toBeDefined();
  });

  it.each([
    {municipality:'Rio de Janeiro',neighborhood:'Flamengo',content:'sou do Flamengo'},
    {municipality:'Maricá',neighborhood:'Itaipuaçu',content:'Itaipuaçu em Maricá'},
    {municipality:null,neighborhood:'Flamengo',content:'agora estou no Flamengo'},
  ])('não reaproveita cidade inferida ou outra região: %j',async memory=>{
    const {client}=database({memory});
    await expect(prepareToolLocation(client,'test','conv','buscar_produto',{bairro:'Flamengo'})).rejects.toBeInstanceOf(AmbiguousNeighborhoodError);
  });

  it('preserva Rio do Ouro/São Gonçalo; pino de Niterói vence a preferência',async()=>{
    const rows=['Niterói','São Gonçalo'].map(city_name=>({city_name,neighborhood_canonical:'rio do ouro',city_resolution_priority:city_name==='São Gonçalo'?100:0}));
    const {client}=database({rows});
    expect(await prepareToolLocation(client,'test','conv','buscar_produto',{bairro:'Rio do Ouro'})).toMatchObject({municipio:'São Gonçalo'});
    mocks.pin.mockResolvedValue({municipio:'Niterói',neighborhoodCanonical:'rio do ouro'});
    expect(await prepareToolLocation(client,'test','conv','buscar_produto',{bairro:'Rio do Ouro'})).toMatchObject({municipio:'Niterói'});
  });

  it('reutiliza a cidade da cotação ao criar o pedido',async()=>{
    const {client}=database({geo:'Maricá'});
    expect(await prepareToolLocation(client,'test','conv','criar_pedido',{bairro:'Flamengo',geo_resolution_id:'geo1'})).toMatchObject({municipio:'Maricá'});
  });

  it('não altera consultas de pedido existente nem o registro silencioso do lead',async()=>{
    const {client,query}=database();
    for(const name of ['consultar_pedido','cancelar_pedido','registrar_localizacao_lead']) {
      const args={bairro:'Flamengo'};
      expect(await prepareToolLocation(client,'test','conv',name,args)).toBe(args);
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('empate de prioridade continua ambíguo e várias linhas da mesma cidade não são ambiguidade',()=>{
    expect(()=>chooseNeighborhoodCity('Flamengo',candidates.map(r=>({...r,city_resolution_priority:100})))).toThrow(AmbiguousNeighborhoodError);
    expect(chooseNeighborhoodCity('Flamengo',[candidates[0]!,candidates[0]!])).toBe('Rio de Janeiro');
  });
});

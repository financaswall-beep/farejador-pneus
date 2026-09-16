import type { PoolClient } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks=vi.hoisted(()=>({
  config:{FAREJADOR_ENV:'test',WHOLESALE_UNIFIED_STOCK:true,ROUTING_GEO:false,
    DATABASE_URL:'postgres://test:test@localhost:5432/test',DATABASE_SSL:false},
  search:vi.fn(),freight:vi.fn(),route:vi.fn(),settings:vi.fn(),pinQuote:vi.fn(),
}));
vi.mock('../../../src/shared/config/env.js',()=>({env:mocks.config}));
vi.mock('../../../src/atendente-v2/matriz-product-search.js',()=>({buscarProdutoMatriz:mocks.search}));
vi.mock('../../../src/atendente/tools/commerce-tools.js',()=>({calcularFrete:mocks.freight}));
vi.mock('../../../src/atendente-v2/delivery-quote-routing.js',()=>({
  fillCityFromPin:async(_db:unknown,_env:unknown,_conv:unknown,location:unknown)=>location,
  decideStoreGeoOrFallback:mocks.route,quoteFreteFromPin:mocks.pinQuote,
}));
vi.mock('../../../src/atendente-v2/matriz-delivery-settings.js',async(importOriginal)=>({
  ...await importOriginal<typeof import('../../../src/atendente-v2/matriz-delivery-settings.js')>(),
  readDeliverySettings:mocks.settings,
}));
import { executeTool } from '../../../src/atendente-v2/tools.js';

const query=vi.fn(async(sql:string)=>{
  // Centro/Itaboraí ausente; nenhum parceiro atendendo a região.
  if(sql.includes('commerce.geo_resolutions')||sql.includes('network.unit_coverage'))return{rows:[]};
  throw Error('Consulta inesperada: '+sql);
});
const client={query} as unknown as PoolClient;
beforeEach(()=>{
  vi.clearAllMocks();
  mocks.search.mockResolvedValue([{product_id:'p1',tire_size:'90/90-12',total_stock_available:1,price_amount:'89.00'}]);
  mocks.freight.mockResolvedValue({encontrado:false,disponivel:false,motivo:'bairro_nao_encontrado'});
  mocks.settings.mockResolvedValue({settings:{delivery_enabled:true}});
  mocks.route.mockResolvedValue({routing:null,matrizFreight:19.90});
  mocks.pinQuote.mockResolvedValue(null);
});
describe('localização explícita sem combinação no dicionário',()=>{
  it('buscar_produto preserva Itaboraí e não pede novamente a localização',async()=>{
    const result=JSON.parse(await executeTool(client,'test','conv','buscar_produto',{
      medida_pneu:'90/90-12',bairro:'Centro',municipio:'Itaboraí',apenas_com_estoque:true,
    }));
    expect(result).toMatchObject({encontrado:true,produtos:[{product_id:'p1',total_stock_available:1}]});
    expect(result).not.toHaveProperty('precisa_localizacao');
    expect(query.mock.calls.some(([sql])=>sql.includes('network.unit_coverage'))).toBe(true);
  });

  it('calcular_frete encaminha município e endereço à régua configurada apesar de bairro ausente',async()=>{
    const result=JSON.parse(await executeTool(client,'test','conv','calcular_frete',{
      bairro:'Centro',municipio:'Itaboraí',endereco_entrega:'Praça Marechal Floriano Peixoto, 1',
      produtos:[{product_id:'p1',quantidade:1}],
    }));
    expect(mocks.route).toHaveBeenCalledWith(client,'test','conv',expect.objectContaining({
      municipio:'Itaboraí',bairro:'Centro',fullAddress:'Praça Marechal Floriano Peixoto, 1',
      items:[{product_id:'p1',quantity:1}],
    }));
    expect(result).toMatchObject({encontrado:true,disponivel:true,valor:'19.90'});
    expect(result).not.toHaveProperty('motivo');
  });

  it('continua respeitando bloqueio de cobertura ou localização, sem inventar entrega',async()=>{
    mocks.route.mockResolvedValue({routing:null,blockReason:'outside_radius'});
    const result=JSON.parse(await executeTool(client,'test','conv','calcular_frete',{
      bairro:'Centro',municipio:'Itaboraí',produtos:[{product_id:'p1',quantidade:1}],
    }));
    expect(result.disponivel).toBe(false);
    expect(result).not.toHaveProperty('valor');
  });
});

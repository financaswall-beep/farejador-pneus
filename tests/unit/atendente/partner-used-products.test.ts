import { describe, expect, it, vi } from 'vitest';
const config=vi.hoisted(()=>({PARTNER_STOCK_CONFIRMATION:true,DATABASE_URL:'postgres://unused:unused@127.0.0.1:1/test',FAREJADOR_ENV:'test'}));
vi.mock('../../../src/shared/config/env.js',()=>({env:config}));
import { partnerUsedProducts, partnerUsedStock } from '../../../src/atendente-v2/partner-used-products.js';
import { basketKey, requestConfirms, requestPublicItems, type StockRequest } from '../../../src/atendente-v2/stock-confirmation-store.js';
import { stockConfirmedText } from '../../../src/atendente-v2/stock-confirmation-worker.js';
const input={environment:'test' as const,medida_pneu:'90/90-18',condicao_pneu:'meia_vida' as const,limit:10,apenas_com_estoque:false};
describe('usado do parceiro sem marca',()=>{
  it('busca candidato sem prometer saldo, preço central ou a marca pedida',async()=>{
    const query=vi.fn().mockResolvedValue({rows:[{product_id:'generic',partner_generic:true,brand:null,price_amount:'99',total_stock_available:99}]});
    const result=await partnerUsedProducts({query} as never,{...input,marca:'Pirelli'});
    expect(result).toEqual([expect.objectContaining({brand:null,total_stock_available:0,price_amount:null,requested_brand:'Pirelli',marca_exige_confirmacao:true})]);
    expect(query.mock.calls[0][1]).toEqual(['test','90/90-18',null]);
  });
  it('não oferece usado em busca de novo/remold nem com confirmação física desligada',async()=>{
    const query=vi.fn();
    for(const condicao_pneu of ['novo','remold'] as const) expect(await partnerUsedProducts({query} as never,{...input,condicao_pneu})).toEqual([]);
    config.PARTNER_STOCK_CONFIRMATION=false;
    try { expect(await partnerUsedProducts({query} as never,input)).toEqual([]); }
    finally {config.PARTNER_STOCK_CONFIRMATION=true;}
    expect(query).not.toHaveBeenCalled();
  });
  it('verificar SKU genérico nunca inventa estoque da Matriz',async()=>{
    const query=vi.fn().mockResolvedValue({rows:[{product_id:'generic',product_name:'Pneu usado'}]});
    const result=await partnerUsedStock({query} as never,'test','generic');
    expect(result).toMatchObject({partner_generic:true,disponibilidade_confirmada:false,precisa_localizacao:true});
    expect(result).not.toHaveProperty('disponivel',true);
    expect(result).not.toHaveProperty('quantidade_total');
  });
  it('uma confirmação genérica não confirma Pirelli; trocar a marca muda a consulta',()=>{
    const item={product_id:'generic',quantity:2};
    const request={status:'confirmed',unit_id:'loja',valid_until:new Date(Date.now()+60_000),routing:{items:[item]}} as StockRequest;
    expect(requestConfirms(request,'loja',[item])).toBe(true);
    expect(requestConfirms(request,'loja',[{...item,requested_brand:'Pirelli'}])).toBe(false);
    request.routing.items[0]={...item,requested_brand:'Pirelli'};
    expect(requestConfirms(request,'loja',[{...item,requested_brand:'pirelli'}])).toBe(true);
    expect(requestConfirms(request,'loja',[{...item,requested_brand:'Michelin'}])).toBe(false);
    expect(requestConfirms(request,'loja',[{...item,quantity:3,requested_brand:'Pirelli'}])).toBe(false);
    expect(requestConfirms(request,'outra',[item])).toBe(false);
    expect(basketKey([item])).not.toBe(basketKey([{...item,requested_brand:'Pirelli'}]));
    expect(basketKey([{...item,requested_brand:'Michelin'}])).not.toBe(basketKey([{...item,requested_brand:'Pirelli'}]));
  });
  it('envia a marca pedida ao app e só anuncia essa marca após TENHO',async()=>{
    const query=vi.fn().mockResolvedValue({rows:[{id:'stock',tire_size:'90/90-18',tire_condition:'meia_vida',brand:null,sale_price:'55.00'}]});
    const items=await requestPublicItems({query} as never,'test',{unitId:'loja',items:[{product_id:'generic',partner_stock_id:'stock',quantity:2}]} as never,
      [{product_id:'generic',quantity:2,requested_brand:'Pirelli'}]);
    expect(items[0]).toMatchObject({brand:'Pirelli',requested_brand:'Pirelli',quantity:2,price:55});
    expect(stockConfirmedText({items} as StockRequest)).toContain('2 × 90/90-18 Pirelli');
    expect(stockConfirmedText({items} as StockRequest)).toContain('55,00');
    expect(stockConfirmedText({items} as StockRequest)).toContain('Meia-vida');
    expect(stockConfirmedText({items} as StockRequest)).not.toMatch(/prefere|buscar|receber|\?/i);
  });
});

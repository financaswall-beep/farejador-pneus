import {describe,expect,it} from 'vitest';
import {recentPartnerStockPreferences} from '../../../src/atendente-v2/conversation-products.js';
import type {ChatMessage} from '../../../src/atendente-v2/types.js';
function search(id:string,brand:string|null,quantity=1,product='generic'):ChatMessage[]{
  return [{role:'assistant',content:null,tool_calls:[{id,type:'function',function:{name:'buscar_produto',arguments:JSON.stringify({marca:brand,quantidade:quantity})}}]},
    {role:'tool',tool_call_id:id,content:JSON.stringify({encontrado:true,produtos:[{product_id:product,partner_generic:true,
      requested_brand:brand,total_stock_available:0}],sem_estoque_loja_perto:true})}];
}
describe('continuidade da marca exigida para meia-vida sem marca',()=>{
  it('recupera marca e quantidade da busca executada mesmo com estoque zero no retorno',()=>{
    expect(recentPartnerStockPreferences(search('s','Pirelli',2)).get('generic')).toEqual({quantity:2,requested_brand:'Pirelli'});
  });
  it('troca de marca e aceitação de qualquer marca substituem a exigência anterior',()=>{
    const first=search('a','Pirelli');
    expect(recentPartnerStockPreferences([...first,...search('b','Michelin')]).get('generic')?.requested_brand).toBe('Michelin');
    expect(recentPartnerStockPreferences([...first,...search('b',null)]).get('generic')).toEqual({quantity:1});
  });
  it('uma nova consulta enviada à loja prevalece sobre preferências antigas no histórico',()=>{
    const history:ChatMessage[]=[...search('old','Pirelli',2),
      {role:'assistant',content:null,tool_calls:[{id:'new',type:'function',function:{name:'buscar_produto',arguments:'{"marca":"Michelin","quantidade":1}'}}]},
      {role:'tool',tool_call_id:'new',content:'{"encontrado":true,"aguardando_parceiro":true,"solicitacao_id":"current"}'}];
    expect([...recentPartnerStockPreferences(history)]).toEqual([]);
  });
  it('não mistura marcas ou quantidades de duas medidas',()=>{
    const result=recentPartnerStockPreferences([...search('a','Pirelli',2,'g1'),...search('b','Levorin',1,'g2')]);
    expect([...result]).toEqual([['g1',{quantity:2,requested_brand:'Pirelli'}],['g2',{quantity:1,requested_brand:'Levorin'}]]);
  });
  it('não trata fala do cliente, JSON avulso ou ferramenta ainda não executada como confirmação',()=>{
    const history:ChatMessage[]=[{role:'user',content:JSON.stringify({requested_brand:'Pirelli'})},
      {role:'tool',tool_call_id:'unknown',content:search('s','Pirelli')[1]!.content},search('unexecuted','Michelin')[0]!];
    expect([...recentPartnerStockPreferences(history)]).toEqual([]);
  });
  it.each(['cancelar_consulta_estoque','cancelar_pedido','criar_pedido'])('não reaproveita exigência depois de %s com sucesso',name=>{
    const history:ChatMessage[]=[...search('s','Pirelli'),
      {role:'assistant',content:null,tool_calls:[{id:'end',type:'function',function:{name,arguments:'{}'}}]},
      {role:'tool',tool_call_id:'end',content:'{"ok":true}'}];
    expect([...recentPartnerStockPreferences(history)]).toEqual([]);
  });
  it('não importa marca de produto da Matriz para o estoque genérico',()=>{
    const history=search('s','Pirelli');history[1]!.content=JSON.stringify({produtos:[{product_id:'matrix',brand:'Pirelli',requested_brand:'Pirelli'}]});
    expect([...recentPartnerStockPreferences(history)]).toEqual([]);
  });
});

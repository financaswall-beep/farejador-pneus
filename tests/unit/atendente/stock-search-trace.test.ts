import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { withStockSearchTrace, observeSearchProducts, observeSearchStore, observeSearchMunicipality } from '../../../src/atendente-v2/stock-search-trace.js';

describe('observação das buscas sem interferir no bot', () => {
  it('agrupa marcas pela medida; registra zero e preserva o resultado byte a byte', async () => {
    const query=vi.fn().mockResolvedValue({rows:[]}),client={query} as unknown as PoolClient;
    const result='{"encontrado":true,"produtos":[]}';
    await expect(withStockSearchTrace(client,'test','conversation',{key:'job:0:0',tool:'buscar_produto',args:{bairro:'privado',marca:'X'}},async()=>{
      observeSearchProducts([{id:'a',measure:'90/90-12',matrixAvailable:0},{id:'b',measure:'90/90-12',matrixAvailable:3}]);
      observeSearchMunicipality('São Gonçalo');
      observeSearchStore('loja-a','Parceiro A',new Map());
      observeSearchStore('loja-b','Parceiro B',new Map([['a',2]]));
      return result;
    })).resolves.toBe(result);
    const values=query.mock.calls[0]![1];
    expect(JSON.parse(values[5])).toEqual({marca:'X'});
    expect(JSON.parse(values[6])).toEqual([{measure:'90/90-12',stores:[
      {id:'loja-a',name:'Parceiro A',kind:'partner',available:false},
      {id:'loja-b',name:'Parceiro B',kind:'partner',available:true},
      {id:'matriz',name:'Matriz',kind:'matrix',available:true},
    ]}]);
  });
  it('falha no registro não altera resposta; não atribui estoque legado à Matriz', async()=>{
    const query=vi.fn().mockRejectedValue(new Error('migration ausente')),client={query} as unknown as PoolClient;
    await expect(withStockSearchTrace(client,'test','c',{key:'k',tool:'buscar_produto',args:{}},async()=>{
      observeSearchProducts([{id:'a',measure:'180/55-17',matrixAvailable:null}]);
      observeSearchStore('a','Loja A',new Map());return 'ok';
    })).resolves.toBe('ok');
    expect(query).not.toHaveBeenCalled(); // retorno inválido nunca gera observação
    await expect(withStockSearchTrace(client,'test','c',{key:'k',tool:'buscar_produto',args:{}},async()=>{
      observeSearchProducts([{id:'a',measure:'180/55-17',matrixAvailable:null}]);
      observeSearchStore('a','Loja A',new Map());return '{"encontrado":true}';
    })).resolves.toBe('{"encontrado":true}');
    expect(JSON.parse(query.mock.calls[0]![1][6])[0].stores).toHaveLength(1);
  });
  it('isola contextos concorrentes e ignora ferramentas de escrita',async()=>{
    const query=vi.fn().mockResolvedValue({rows:[]}),client={query} as unknown as PoolClient;
    await Promise.all(['prod','test'].map(environment=>withStockSearchTrace(client,environment as 'prod'|'test','c',
      {key:environment,tool:'buscar_produto',args:{}},async()=>{
        observeSearchProducts([{id:'a',measure:environment==='prod'?'90/90-12':'180/55-17',matrixAvailable:0}]);
        await Promise.resolve();return '{}';
      })));
    expect(query.mock.calls.map(c=>[c[1][0],JSON.parse(c[1][6])[0].measure]).sort()).toEqual([['prod','90/90-12'],['test','180/55-17']]);
    query.mockClear();
    await withStockSearchTrace(client,'test','c',{key:'x',tool:'criar_pedido',args:{}},async()=>'pedido');
    expect(query).not.toHaveBeenCalled();
  });
});

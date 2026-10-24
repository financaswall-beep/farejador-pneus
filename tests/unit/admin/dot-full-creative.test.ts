import {expect,it,vi} from 'vitest';
const {query,provider,config,snapshot}=vi.hoisted(()=>({query:vi.fn(),provider:vi.fn(),config:vi.fn(),snapshot:vi.fn()}));
vi.mock('../../../src/shared/config/env.js',()=>({env:{FAREJADOR_ENV:'test'}}));
vi.mock('../../../src/admin/dot/read-only.js',()=>({withDotReadOnly:snapshot}));
vi.mock('../../../src/admin/painel/queries-marketing-creatives.js',()=>({marketingCreativeConfig:config}));
vi.mock('../../../src/marketing/meta-creatives.js',async importOriginal=>({
  ...await importOriginal<typeof import('../../../src/marketing/meta-creatives.js')>(),getMetaCreatives:provider,
}));
import {readFullCreative} from '../../../src/admin/dot/full-creative.js';

it('criativo só consulta o provedor depois da autorização e nunca devolve credenciais ou URLs arbitrárias',async()=>{
  config.mockReturnValue({adAccountId:'act_123',accessToken:'TOKEN-SENTINEL',apiVersion:'v23.0'});
  snapshot.mockImplementation(async work=>work({query}));query.mockResolvedValue({rows:[]});
  await expect(readFullCreative({anuncio_id:'123'})).rejects.toThrow('creative_not_owned');
  expect(provider).not.toHaveBeenCalled();
  expect(query).toHaveBeenCalledWith(expect.stringContaining("a.scope='matrix'"),['test','act_123','123']);
  query.mockResolvedValue({rows:[{}]});
  provider.mockImplementation(async()=>{
    expect(snapshot).toHaveResolvedTimes(2);
    return {ads:[{id:'123',name:'Anúncio próprio',title:'Título',body:'Texto completo',status:'ACTIVE',
      format:'image',image_url:'https://evil.example/image?access_token=TOKEN-SENTINEL',accessToken:'TOKEN-SENTINEL'}]};
  });
  const result=await readFullCreative({anuncio_id:'123'});
  expect(result).toMatchObject({available:true,anuncio:{texto:'Texto completo',titulo:'Título',imagem_url:null}});
  expect(JSON.stringify(result)).not.toContain('TOKEN-SENTINEL');
});

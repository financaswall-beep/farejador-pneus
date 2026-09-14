import {afterEach,describe,it,expect,vi} from 'vitest';
import {clearGeographyMetaCache,getGeographyMeta,metaGeoRequest} from '../../../src/marketing/geography-meta.js';
const config={adAccountId:'act_123',apiVersion:'v21.0',accessToken:'secret-test'};
const window={since:'2026-09-01',until:'2026-09-14',previousSince:'2026-08-18',previousUntil:'2026-08-31'};
afterEach(clearGeographyMetaCache);
const response=(data:any)=>new Response(JSON.stringify({data}));
function api(sets:any[]=[],daily:any='3000') {
  return vi.fn(async(url:any)=>String(url).includes('/insights?')?response([{campaign_id:'1',frequency:'2.4',inline_link_click_ctr:'1.8'}]):
    String(url).includes('/campaigns?')?response([{id:'1',account_id:'123',effective_status:'ACTIVE',daily_budget:daily},{id:'9',account_id:'999'}]):response(sets));
}
const set=(id:string)=>({id,account_id:'123',campaign_id:'1',effective_status:'ACTIVE',daily_budget:'2000',learning_stage_info:{status:'SUCCESS'}});
describe('Geografia: leitura adicional da Meta',()=>{
  it('usa frequência agregada por período e orçamento da campanha, com token só no header',async()=>{
    const fetcher=api([set('11')]);const result=await getGeographyMeta(config,window,fetcher);
    expect(result).toMatchObject({state:'ready',current:[{frequency:2.4,link_ctr:1.8}],campaigns:[{campaign_id:'1',daily_budget:30,budget_level:'campaign',learning:'SUCCESS'}]});
    expect(result.campaigns).toHaveLength(1);expect(String(fetcher.mock.calls[0]![0])).not.toContain('time_increment');
    expect(String(fetcher.mock.calls[0]![0])).not.toContain(config.accessToken);
    await getGeographyMeta(config,window,fetcher);expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it('usa o conjunto único mas não soma orçamentos de vários conjuntos',async()=>{
    const single=await getGeographyMeta(config,window,api([set('11')],0));
    expect(single.campaigns[0]).toMatchObject({daily_budget:20,budget_entity_id:'11',budget_level:'adset'});
    clearGeographyMetaCache();const multiple=await getGeographyMeta(config,window,api([set('11'),set('12')],null));
    expect(multiple.campaigns[0]).toMatchObject({daily_budget:null,budget_entity_id:null});
  });
  it('mantém os dados parciais e não presume aprendizado concluído quando a Meta falha',async()=>{
    const base=api();const fetcher=vi.fn(async(url:any)=>String(url).includes('/adsets?')?new Response('{}',{status:403}):base(url));
    const result=await getGeographyMeta(config,window,fetcher);expect(result.state).toBe('partial');expect(result.campaigns[0]!.learning).toBeNull();
    clearGeographyMetaCache();expect((await getGeographyMeta(config,window,vi.fn().mockRejectedValue(Error('offline')))).state).toBe('unavailable');
  });
  it('não permite paginação trocar de origem nem vazar token',async()=>{
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({data:[],paging:{next:'https://evil.test/?access_token=secret'}})));
    await expect(metaGeoRequest(config,'act_123/insights',{},fetcher)).rejects.toThrow('meta_geo_origin');expect(fetcher).toHaveBeenCalledTimes(1);
    const next=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({data:[],paging:{next:'https://graph.facebook.com/v21.0/x?access_token=secret'}}))).mockResolvedValueOnce(response([]));
    await metaGeoRequest(config,'act_123/insights',{},next);expect(String(next.mock.calls[1]![0])).not.toContain('access_token');
  });
  it('recusa resultados truncados e formatos inesperados',async()=>{
    const fetcher=vi.fn().mockImplementation(async()=>new Response(JSON.stringify({data:[],paging:{next:'https://graph.facebook.com/v21.0/x'}})));
    await expect(metaGeoRequest(config,'act_123/insights',{},fetcher)).rejects.toThrow('meta_geo_limit');
    await expect(metaGeoRequest(config,'act_123/insights',{},vi.fn().mockResolvedValue(new Response('{}')))).rejects.toThrow('meta_geo_shape');
  });
});

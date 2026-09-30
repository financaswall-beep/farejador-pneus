import type {Pool} from 'pg';
import {beforeEach,describe,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({list:vi.fn(),post:vi.fn(),insights:vi.fn(),signed:vi.fn()}));
vi.mock('../../../src/social-comments/publications.js',()=>({readPublications:mocks.list,PublicationsGraph:class{publication=mocks.post}}));
vi.mock('../../../src/marketing/publisher/storage.js',()=>({PublisherStorage:class{signedUrl=mocks.signed}}));
vi.mock('../../../src/marketing/publisher/config.js',()=>({publisherConfig:()=>({sending:true})}));
vi.mock('../../../src/marketing/organic/insights.js',()=>({organicInsights:mocks.insights}));
import {centralResults,organicResults,organicResultMetrics} from '../../../src/marketing/organic/results.js';
import {mergeOrganicResults,type CentralResult} from '../../../src/marketing/organic/results-model.js';
const config={enabled:true,publish:true,scopeValid:true,token:'secret',pageId:'100',instagramId:'200',apiVersion:'v26.0'};
const central=():CentralResult=>({id:'one',title:'Interno',caption:'Pneus',status:'published',version:4,
  created_at:'2026-09-29T12:00:00Z',scheduled_at:'2026-09-29T12:00:00Z',thumbnail_path:'test/path',
  deliveries:[{platform:'instagram',account_id:'200',post_id:'301',status:'published',format:'feed',published_at:'2026-09-29T12:00:00Z',
    views:null,observed_at:null,post_url:null,error_code:null}]});
function db(ready=true){
  const query=vi.fn(async(sql:string)=>({rows:sql.includes('to_regclass')?[{ready}]:sql.includes('FROM ops.publisher_posts')?[central()]:[]}));
  return {pool:{query} as unknown as Pool,query};
}
describe('Motor unificado de resultados',()=>{
  beforeEach(()=>vi.resetAllMocks());
  it('normaliza datas do pg e descarta destinos de outra conta',async()=>{
    const a=db();const row=central();row.deliveries.push({...row.deliveries[0]!,account_id:'999',platform:'facebook'});
    a.query.mockImplementation(async(sql:string)=>({rows:sql.includes('to_regclass')?[{ready:true}]:
      [{...row,created_at:new Date(row.created_at),scheduled_at:new Date(row.scheduled_at)}]}));
    const saved=await centralResults(a.pool,'test',config);
    expect(saved.rows[0]!.deliveries).toHaveLength(1);expect(saved.rows[0]!.created_at).toBe(new Date(row.created_at).toISOString());
    const call=a.query.mock.calls[1] as any;expect(call[0]).toContain('WHERE p.environment=$1');expect(call[1]).toEqual(['test']);
  });
  it('uma falha na Meta ou na miniatura mantém o histórico da Central acessível',async()=>{
    mocks.list.mockRejectedValue(Error('offline'));mocks.signed.mockRejectedValue(Error('storage offline'));
    const a=db();const result=await organicResults(a.pool,'test',config,'2026-09-01');
    expect(result.rows).toHaveLength(1);expect(result.central_available).toBe(true);
    expect(result.active_platforms).toEqual(['instagram','facebook']);expect(result.rows[0]!.image_url).toBe(null);
    expect(result.sources.every(s=>s.status==='unavailable')).toBe(true);
  });
  it('uma rede sem insights não apaga os contadores da outra nem inventa zero',async()=>{
    const saved=central();saved.deliveries.push({...saved.deliveries[0]!,platform:'facebook',account_id:'100',post_id:'302'});
    const row=mergeOrganicResults([],[saved],['instagram','facebook'])[0]!;
    mocks.insights.mockImplementation(async(_:any,platform:string)=>{
      if(platform==='facebook')throw Error('offline');
      return {fetched_at:'2026-09-30T12:00:00Z',rows:[{metric:'views',value:0}]};
    });
    const a=db();const result=await organicResultMetrics(a.pool,'test',config,row,7,false);
    expect(result.networks[0]).toMatchObject({views:0,error:null});
    expect(result.networks[1]).toMatchObject({views:null,error:'organic_insights_unavailable'});
    expect(a.query.mock.calls.filter(([sql])=>sql.includes('INSERT INTO'))).toHaveLength(1);
  });
  it('destino incerto não consulta nem grava métricas como se tivesse publicado',async()=>{
    const saved=central();saved.deliveries[0]!.status='uncertain';
    const row=mergeOrganicResults([],[saved],['instagram','facebook'])[0]!;
    const a=db();const result=await organicResultMetrics(a.pool,'test',config,row,7,false);
    expect(mocks.insights).not.toHaveBeenCalled();expect(result.networks[0]!.insights).toBe(null);
    expect(a.query.mock.calls.filter(([sql])=>sql.includes('INSERT INTO'))).toHaveLength(0);
  });
});

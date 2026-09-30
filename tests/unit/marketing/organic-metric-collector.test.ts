import {beforeEach,describe,it,expect,vi} from 'vitest';
import type {Pool} from 'pg';
const mocks=vi.hoisted(()=>({list:vi.fn(),views:vi.fn()}));
vi.mock('../../../src/persistence/db.js',()=>({pool:{}}));
vi.mock('../../../src/shared/config/env.js',()=>({env:{}}));
vi.mock('../../../src/social-comments/publications.js',()=>({readPublications:mocks.list}));
vi.mock('../../../src/marketing/organic/insights.js',()=>({InsightsGraph:class{readViews=mocks.views}}));
import {collectOrganicMetrics} from '../../../src/marketing/organic/metric-collector.js';
const config={enabled:true,publish:true,scopeValid:true,token:'secret',pageId:'100',instagramId:'200',apiVersion:'v26.0'};
function db(acquired=true){
  const release=vi.fn(),query=vi.fn(async(sql:string)=>({rows:
    sql.includes('to_regclass')?[{ready:true}]:sql.includes('pg_try_advisory_lock')?[{acquired}]:[]}));
  const client={query,release};return {pool:{query,connect:vi.fn(async()=>client)} as unknown as Pool,query,release};
}
describe('Coleta limitada de métricas orgânicas',()=>{
  beforeEach(()=>{vi.resetAllMocks();mocks.views.mockResolvedValue(0);});
  it('não consulta a rede quando desativada ou sem migration',async()=>{
    const a=db();await collectOrganicMetrics(a.pool,'test',{...config,token:undefined});expect(a.query).not.toHaveBeenCalled();
    a.query.mockResolvedValue({rows:[{ready:false}]});await collectOrganicMetrics(a.pool,'test',config);
    expect(mocks.list).not.toHaveBeenCalled();expect(a.pool.connect).not.toHaveBeenCalled();
  });
  it('o lock impede duas réplicas de coletar e sempre libera a conexão',async()=>{
    const a=db(false);await collectOrganicMetrics(a.pool,'test',config);
    expect(mocks.list).not.toHaveBeenCalled();expect(a.release).toHaveBeenCalledOnce();
    expect(a.query.mock.calls.find(([sql])=>sql.includes('advisory_unlock'))).toBeUndefined();
  });
  it('limita o lote a 24 posts, mantém zero e registra falha como ausente',async()=>{
    mocks.list.mockResolvedValue({rows:Array.from({length:40},(_,i)=>({platform:'instagram',account_id:'200',id:String(i+1),published_at:'2026-09-29T12:00:00Z'}))});
    mocks.views.mockRejectedValueOnce(Error('token=secret'));const a=db();await collectOrganicMetrics(a.pool,'test',config);
    expect(mocks.views).toHaveBeenCalledTimes(24);
    const inserts=a.query.mock.calls.filter(([sql])=>sql.includes('INSERT INTO')) as any[];
    expect(inserts).toHaveLength(24);expect(inserts[0][1]).toMatchObject(['test','instagram','200','1',expect.any(String),'views',null]);
    expect(inserts[1][1].at(-1)).toBe(0);
    const cleanup=a.query.mock.calls.find(([sql])=>sql.includes('DELETE FROM')) as any;
    expect(cleanup[0]).toContain('WHERE environment=$1');expect(cleanup[1]).toEqual(['test']);
    expect(a.release).toHaveBeenCalledOnce();
  });
  it('libera conexão mesmo se a leitura da rede falhar',async()=>{
    mocks.list.mockRejectedValue(Error('offline'));const a=db();await expect(collectOrganicMetrics(a.pool,'test',config)).rejects.toThrow('offline');
    expect(a.query.mock.calls.at(-1)?.[0]).toContain('advisory_unlock');expect(a.release).toHaveBeenCalledOnce();
  });
});

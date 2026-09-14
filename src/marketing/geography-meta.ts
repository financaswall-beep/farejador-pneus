import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { MetaMarketingConfig } from '../admin/painel/marketing-meta.js';
import type { GeoDiagnostic, GeoMeta } from './geography-types.js';

type Json = Record<string, any>;
const obj = (v: unknown): Json => v && typeof v==='object' && !Array.isArray(v) ? v as Json : {};
const nullable = (v: unknown) => v!=null && v!=='' && Number.isFinite(Number(v)) && Number(v)>=0 ? Number(v) : null;
const cache = new Map<string,{ expires: number; result: MetaGeographyResult }>();
export interface MetaGeographyResult {
  state: 'ready'|'partial'|'unavailable'; campaigns: GeoMeta[];
  current: GeoDiagnostic[]; previous: GeoDiagnostic[];
}
/** Token somente no header; paginação não pode trocar o host nem produzir totais truncados. */
export async function metaGeoRequest(config: MetaMarketingConfig, path: string, params: Record<string,string>, fetcher: typeof fetch) {
  let next: URL|null = new URL(`https://graph.facebook.com/${encodeURIComponent(config.apiVersion)}/${path}`);
  next.search=new URLSearchParams(params).toString();
  const rows: Json[]=[];
  for(let page=0;next && page<5;page++) {
    if(next.protocol!=='https:' || next.hostname!=='graph.facebook.com' || next.username || next.password || (next.port && next.port!=='443')) throw Error('meta_geo_origin');
    next.searchParams.delete('access_token');
    const response=await fetcher(next,{headers:{Authorization:`Bearer ${config.accessToken}`},signal:AbortSignal.timeout(12000),redirect:'error'});
    if(!response.ok) throw Error('meta_geo_unavailable');
    const body=obj(await response.json());
    if(body.error) throw Error('meta_geo_unavailable');
    if(!Array.isArray(body.data)) throw Error('meta_geo_shape');
    rows.push(...body.data.map(obj));
    if(rows.length>1000) throw Error('meta_geo_limit');
    next=body.paging?.next ? new URL(body.paging.next) : null;
  }
  if(next) throw Error('meta_geo_limit');
  return rows;
}
export function metaDiagnostic(row: Json): GeoDiagnostic|null {
  if(!/^\d+$/.test(String(row.campaign_id))) return null;
  return {campaign_id:String(row.campaign_id),frequency:nullable(row.frequency),link_ctr:nullable(row.inline_link_click_ctr)};
}
export async function getGeographyMeta(config: MetaMarketingConfig, windows: {
  since:string;until:string;previousSince:string;previousUntil:string;
}, fetcher: typeof fetch=fetch): Promise<MetaGeographyResult> {
  const key=[config.adAccountId,config.apiVersion,createHash('sha256').update(config.accessToken).digest('hex'),JSON.stringify(windows)].join(':');
  const saved=cache.get(key);if(saved && saved.expires>Date.now()) return saved.result;
  const query=(since:string,until:string)=>metaGeoRequest(config,`${config.adAccountId}/insights`,{
    fields:'campaign_id,frequency,inline_link_click_ctr',level:'campaign',time_range:JSON.stringify({since,until}),limit:'200',
  },fetcher);
  const results=await Promise.allSettled([
    query(windows.since,windows.until),query(windows.previousSince,windows.previousUntil),
    metaGeoRequest(config,`${config.adAccountId}/campaigns`,{fields:'id,account_id,effective_status,daily_budget',limit:'200'},fetcher),
    metaGeoRequest(config,`${config.adAccountId}/adsets`,{fields:'id,account_id,campaign_id,effective_status,daily_budget,learning_stage_info',limit:'200'},fetcher),
  ]);
  const rows=(i:number)=>results[i]?.status==='fulfilled' ? (results[i] as PromiseFulfilledResult<Json[]>).value : [];
  const account=config.adAccountId.replace(/^act_/,'');
  const campaigns=rows(2).filter(r=>String(r.account_id)===account && /^\d+$/.test(String(r.id))).map((r):GeoMeta=>{
    const sets=rows(3).filter(s=>String(s.account_id)===account && String(s.campaign_id)===String(r.id) && s.effective_status==='ACTIVE');
    const daily=nullable(r.daily_budget);
    const single=sets.length===1 && (daily==null || daily===0) ? sets[0] : null;
    const learning=sets.map(s=>String(obj(s.learning_stage_info).status ?? 'UNKNOWN'));
    return {campaign_id:String(r.id),status:typeof r.effective_status==='string'?r.effective_status:null,
      daily_budget:daily!=null && daily>0?daily/100:single && nullable(single.daily_budget)!=null?Number(single.daily_budget)/100:null,
      budget_entity_id:daily!=null && daily>0?String(r.id):single?String(single.id):null,
      budget_level:daily!=null && daily>0?'campaign':single?'adset':null,
      learning:!learning.length || learning.includes('UNKNOWN') ? null : learning.every(v=>v==='SUCCESS')?'SUCCESS':learning[0]==='SUCCESS'?learning.find(v=>v!=='SUCCESS')!:learning[0]!,
    };
  });
  const successful=results.filter(r=>r.status==='fulfilled').length;
  const result:MetaGeographyResult={state:successful===4?'ready':successful?'partial':'unavailable',campaigns,
    current:rows(0).map(metaDiagnostic).filter((r):r is GeoDiagnostic=>!!r),previous:rows(1).map(metaDiagnostic).filter((r):r is GeoDiagnostic=>!!r)};
  cache.set(key,{expires:Date.now()+(successful===4?900000:60000),result});
  while(cache.size>20)cache.delete(cache.keys().next().value!);
  return result;
}
export function clearGeographyMetaCache(){cache.clear();}

/** Chamado pelo ciclo de sincronização. Ausência da migration não afeta a coleta existente. */
export async function saveGeographyObservations(db: Pool, environment: string, account: string, campaigns: GeoMeta[]) {
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('marketing_geo_observations'),hashtext($1))",[environment+account]);
    for(const row of campaigns) {
      await client.query(`INSERT INTO marketing.geography_meta_snapshots(environment,ad_account_id,campaign_id,payload)
        SELECT $1,$2,$3,$4::jsonb WHERE NOT EXISTS(
          SELECT 1 FROM (SELECT payload,observed_at FROM marketing.geography_meta_snapshots
            WHERE environment=$1 AND ad_account_id=$2 AND campaign_id=$3 ORDER BY observed_at DESC LIMIT 1) latest
          WHERE payload=$4::jsonb AND observed_at>now()-interval '1 day')`,[environment,account,row.campaign_id,JSON.stringify(row)]);
    }
    await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}

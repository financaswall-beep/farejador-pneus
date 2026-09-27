import { createHash } from 'node:crypto';
import { PublicationsGraph } from '../../social-comments/publications.js';
import { type CommentsConfig, type Platform } from '../../social-comments/config.js';
import { MetaCommentError } from '../../social-comments/graph.js';

export function insightValue(data: any, metric: string): number | null {
  const item=Array.isArray(data?.data)?data.data.find((r:any)=>r.name===metric):null;
  const value=item?.total_value?.value ?? (item?.values?.length===1?item.values[0].value:null);
  return typeof value==='number' && Number.isFinite(value) && value>=0 ? value : null;
}
const metrics: Record<Platform,Array<[string,string]>> = {
  instagram:[['reach','Contas alcançadas'],['views','Visualizações'],['likes','Curtidas'],['comments','Comentários'],
    ['shares','Compartilhamentos'],['saved','Salvamentos'],['total_interactions','Interações'],['reposts','Reposts']],
  facebook:[['post_media_view','Visualizações'],['post_total_media_view_unique','Pessoas alcançadas']],
};
class InsightsGraph extends PublicationsGraph {
  async read(platform:Platform, account:string, postId:string) {
    const post=await this.publication(platform,account,postId);
    const requested=[...metrics[platform]];
    if(platform==='instagram' && ['video','reel'].includes(post.format)) requested.push(
      ['ig_reels_avg_watch_time','Tempo médio assistido (ms)'],['ig_reels_video_view_total_time','Tempo total assistido (ms)']);
    const rows:Array<{metric:string;label:string;value:number|null;reason:string|null}>=[];
    // Isola métricas retiradas/não suportadas sem invalidar as demais.
    for(let i=0;i<requested.length;i+=3) {
      rows.push(...await Promise.all(requested.slice(i,i+3).map(async([metric,label])=>{
        try {const data=await this.call(`${postId}/insights`,'GET',{metric,period:'lifetime'});
          const value=insightValue(data,metric);
          return {metric,label,value,reason:value===null?'not_provided':null};
        }catch(error){return {metric,label,value:null,reason:error instanceof MetaCommentError ? error.code:'unavailable'};}
      })));
    }
    if(platform==='facebook') {
      for(const [metric,label,field] of [['reactions','Reações','reactions.limit(0).summary(true)'],
        ['comments','Comentários','comments.limit(0).summary(true)'],['shares','Compartilhamentos','shares']] as const) {
        try {const data=await this.call(postId,'GET',{fields:field});
          const n=metric==='shares'?data.shares?.count:data[metric]?.summary?.total_count;
          rows.push({metric,label,value:typeof n==='number' && n>=0?n:null,reason:typeof n==='number'?null:'not_provided'});
        }catch{rows.push({metric,label,value:null,reason:'unavailable'});}
      }
    }
    return {source:'Meta',period:'lifetime',fetched_at:new Date().toISOString(),rows,
      note:'Acumulado da publicação consultado na Meta. Pode incluir impulsionamento. Não corresponde ao filtro de 7/30 dias das vendas. Indisponível não significa zero.'};
  }
}
const cache=new Map<string,{expires:number;value:ReturnType<InsightsGraph['read']>}>();
export async function organicInsights(config:CommentsConfig,platform:Platform,account:string,postId:string) {
  const key=createHash('sha256').update(JSON.stringify([config.token,config.apiVersion,platform,account,postId])).digest('hex');
  const previous=cache.get(key);
  if(previous && previous.expires>Date.now())return previous.value;
  const value=new InsightsGraph(config).read(platform,account,postId);
  cache.set(key,{expires:Date.now()+300000,value});
  while(cache.size>100)cache.delete(cache.keys().next().value!);
  try{return await value;}catch(error){cache.delete(key);throw error;}
}

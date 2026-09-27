import { createHash } from 'node:crypto';
import { PublicationsGraph } from '../../social-comments/publications.js';
import { type CommentsConfig, type Platform } from '../../social-comments/config.js';
import { MetaCommentError } from '../../social-comments/graph.js';

export function insightValue(data: any, metric: string): number | null {
  const item=Array.isArray(data?.data)?data.data.find((r:any)=>r.name===metric):null;
  const value=item?.total_value?.value ?? (item?.values?.length===1?item.values[0].value:null);
  return metricValue(value);
}
function metricValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
type MetricRow = { metric: string; label: string; value: number | null; reason: string | null; message: string | null };
function metricRow(metric: string, label: string, value: number | null, reason = 'not_provided'): MetricRow {
  const message = /_code_(10|200)$/.test(reason) ? 'A Meta não autorizou a leitura desta métrica.'
    : /_code_190$/.test(reason) || reason === 'meta_token_missing' ? 'Reconecte a conta para consultar esta métrica.'
    : reason === 'not_provided' ? 'A Meta não informou este dado para a publicação.'
    : /_code_100$/.test(reason) ? 'A Meta não disponibilizou esta métrica para esta consulta.'
    : 'Não foi possível consultar agora. Tente atualizar.';
  return { metric, label, value, reason: value === null ? reason : null, message: value === null ? message : null };
}
const metrics: Record<Platform,Array<[string,string]>> = {
  instagram:[['reach','Contas alcançadas'],['views','Visualizações'],['likes','Curtidas'],['comments','Comentários'],
    ['shares','Compartilhamentos'],['saved','Salvamentos'],['total_interactions','Interações'],['reposts','Reposts']],
  facebook:[['post_media_view','Visualizações'],['post_total_media_view_unique','Pessoas alcançadas']],
};
export class InsightsGraph extends PublicationsGraph {
  async read(platform:Platform, account:string, postId:string) {
    const post=await this.publication(platform,account,postId);
    // Contadores do post continuam disponíveis mesmo sem acesso aos Insights.
    // Ausência do campo não significa zero (ex.: curtidas ocultas ou formato incompatível).
    const basic = new Map<string, number>();
    if (platform === 'instagram') {
      try {
        const data = await this.call(postId, 'GET', { fields: 'like_count,comments_count' });
        for (const [metric, field] of [['likes', 'like_count'], ['comments', 'comments_count']] as const) {
          const value = metricValue(data[field]);
          if (value !== null) basic.set(metric, value);
        }
      } catch { /* Consulta individual via Insights abaixo quando o contador não estiver disponível. */ }
    }
    const requested=[...metrics[platform]];
    if(platform==='instagram' && ['video','reel'].includes(post.format)) requested.push(
      ['ig_reels_avg_watch_time','Tempo médio assistido (ms)'],['ig_reels_video_view_total_time','Tempo total assistido (ms)']);
    const rows: MetricRow[]=[];
    // Isola métricas retiradas/não suportadas sem invalidar as demais.
    for(let i=0;i<requested.length;i+=3) {
      rows.push(...await Promise.all(requested.slice(i,i+3).map(async([metric,label])=>{
        if (basic.has(metric)) return metricRow(metric, label, basic.get(metric)!);
        try {const data=await this.call(`${postId}/insights`,'GET',{metric,period:'lifetime'});
          const value=insightValue(data,metric);
          return metricRow(metric,label,value);
        }catch(error){return metricRow(metric,label,null,error instanceof MetaCommentError ? error.code:'unavailable');}
      })));
    }
    if(platform==='facebook') {
      for(const [metric,label,field] of [['likes','Curtidas','reactions.type(LIKE).limit(0).summary(true)'],
        ['reactions','Reações (inclui curtidas)','reactions.limit(0).summary(true)'],
        ['comments','Comentários','comments.limit(0).summary(true)'],['shares','Compartilhamentos','shares']] as const) {
        try {const data=await this.call(postId,'GET',{fields:field});
          const n=metric==='shares'?data.shares?.count:data[metric==='likes'?'reactions':metric]?.summary?.total_count;
          rows.push(metricRow(metric,label,metricValue(n)));
        }catch(error){rows.push(metricRow(metric,label,null,error instanceof MetaCommentError ? error.code:'unavailable'));}
      }
    }
    return {source:'Meta',period:'lifetime',fetched_at:new Date().toISOString(),rows,
      notice: rows.some(row => /_code_(10|200)$/.test(row.reason ?? ''))
        ? 'Algumas métricas precisam de autorização na Meta. Os contadores disponíveis continuam sendo exibidos.' : null,
      note:'Acumulado da publicação consultado na Meta. Pode incluir impulsionamento. Não corresponde ao filtro de 7/30 dias das vendas. Indisponível não significa zero.'};
  }
}
const cache=new Map<string,{expires:number;value:ReturnType<InsightsGraph['read']>}>();
export function clearOrganicInsightsCache(): void { cache.clear(); }
export async function organicInsights(config:CommentsConfig,platform:Platform,account:string,postId:string,refresh=false) {
  const key=createHash('sha256').update(JSON.stringify([config.token,config.appSecret,config.apiVersion,
    config.pageId,config.instagramId,config.scopeValid,platform,account,postId])).digest('hex');
  const previous=cache.get(key);
  if(!refresh && previous && previous.expires>Date.now())return previous.value;
  const value=new InsightsGraph(config).read(platform,account,postId);
  cache.set(key,{expires:Date.now()+300000,value});
  while(cache.size>100)cache.delete(cache.keys().next().value!);
  try{return await value;}catch(error){if(cache.get(key)?.value===value)cache.delete(key);throw error;}
}

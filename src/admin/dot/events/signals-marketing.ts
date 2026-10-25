import type { Pool } from 'pg';
import { env } from '../../../shared/config/env.js';
import { businessDateSaoPaulo } from '../../../shared/business-time.js';
import type { DotSettings } from './settings.js';
import { bounded,signal } from './signal-model.js';
import { freshnessMs } from './freshness.js';

interface Campaign {account_id:string;campaign_id:string;spend:string;results:string|null;collected_at:Date;missing:number}
export function campaignAttention(row:Campaign,settings:DotSettings,now:Date,platform:'meta'|'google'='meta') {
 if(Number(row.spend)<settings.marketing_spend_brl)return null;
 const stale=now.getTime()-new Date(row.collected_at).getTime()>freshnessMs(platform,settings);
 if(stale||row.missing>0||row.results===null)return 'conferir_rastreamento_e_atualizacao';
 return Number(row.results)<settings.marketing_min_results?'verba_com_poucos_resultados_registrados':null;
}
export async function marketingSignals(db:Pool,settings:DotSettings,now:Date) {
 const from=businessDateSaoPaulo(new Date(now.getTime()-(settings.marketing_days-1)*86400000)),to=businessDateSaoPaulo(now);
 const campaigns:Array<Campaign&{platform:'meta'|'google';metric:string}>=[];
 if(env.MARKETING_META_ENABLED) {
  const rows=bounded((await db.query<Campaign>(`SELECT i.ad_account_id account_id,i.campaign_id,sum(i.spend)::text spend,
    sum(i.conversations)::text results,min(i.collected_at) collected_at,count(*) FILTER(WHERE i.conversations IS NULL)::int missing
    FROM marketing.meta_insights_daily_scoped i WHERE i.environment=$1 AND i.entity_level='ad'
     AND i.account_currency='BRL' AND i.campaign_scope='matrix' AND i.metric_date BETWEEN $2::date AND $3::date
     AND EXISTS(SELECT 1 FROM marketing.meta_identity_accounts a WHERE a.environment=i.environment AND a.ad_account_id=i.ad_account_id)
    GROUP BY i.ad_account_id,i.campaign_id ORDER BY i.ad_account_id,i.campaign_id LIMIT 1001`,[env.FAREJADOR_ENV,from,to])).rows);
  campaigns.push(...rows.map(row=>({...row,platform:'meta' as const,metric:'conversas_registradas_na_plataforma'})));
 }
 if(env.GOOGLE_ADS_ENABLED) {
  const rows=bounded((await db.query<Campaign>(`SELECT i.account_id,i.campaign_id,(sum(i.cost_micros)::numeric/1000000)::text spend,
    sum(i.conversions)::text results,min(i.collected_at) collected_at,count(*) FILTER(WHERE i.conversions IS NULL)::int missing
    FROM marketing.google_insights_daily i JOIN marketing.google_campaigns c ON c.environment=i.environment
     AND c.account_id=i.account_id AND c.campaign_id=i.campaign_id
    WHERE i.environment=$1 AND c.owned AND i.entity_level='campaign' AND i.metric_date BETWEEN $2::date AND $3::date
    GROUP BY i.account_id,i.campaign_id ORDER BY i.account_id,i.campaign_id LIMIT 1001`,[env.FAREJADOR_ENV,from,to])).rows);
  campaigns.push(...rows.map(row=>({...row,platform:'google' as const,metric:'conversoes_registradas_na_plataforma'})));
 }
 if(!env.MARKETING_META_ENABLED&&!env.GOOGLE_ADS_ENABLED)throw Error('marketing_integrations_disabled');
 return campaigns.flatMap(row=>{const reason=campaignAttention(row,settings,now,row.platform);return reason?[signal(
  'farejador.marketing.atencao',`${row.platform}:${row.account_id}:${row.campaign_id}`,reason,
  row.platform==='meta'?'marketing.meta_insights_daily_scoped':'marketing.google_insights_daily',
  {platform:row.platform,campaign_id:row.campaign_id,spend_brl:row.spend,currency:'BRL',from,to,
   platform_results:row.results,metric:row.metric,collected_at:row.collected_at,scope:row.platform==='meta'?'anuncios_proprios_da_campanha':'campanha_propria',
   attribution_enabled:env.MARKETING_ATTRIBUTION,qualified_conversations:null,realized_sales:null,
   interpretation:'Conferir rastreamento, qualidade e vendas atribuídas antes de recomendar mudança de campanha.'},now,
  [from,to,reason,Math.floor(Number(row.spend)/settings.marketing_spend_brl),row.results])]:[];});
}

import { env } from '../../shared/config/env.js';
import { REALIZED_CTE } from '../../marketing/reporting.js';
import { readPage, pageRows, rejectFilters, type DotReadContext } from './read-model.js';

export async function readDotMarketing(ctx:DotReadContext,view:'campanhas'|'anuncios'|'google'|'publicacoes'|'regioes'|'atribuicao') {
  rejectFilters(ctx,'medida');
  if(view!=='publicacoes')rejectFilters(ctx,'referencia');
  if(['campanhas','anuncios','regioes','atribuicao'].includes(view)) {
    const identity=await ctx.db.query(`SELECT EXISTS(SELECT 1 FROM marketing.meta_identity_accounts WHERE environment=$1) ready`,[env.FAREJADOR_ENV]);
    if(!identity.rows[0].ready)return {available:false,reason:'meta_identity_not_verified'};
  }
  if(view==='publicacoes')return readPage(ctx,`SELECT p.id,p.status,p.created_at,p.scheduled_at,p.updated_at,
    (SELECT jsonb_agg(jsonb_build_object('platform',d.platform,'format',d.format,'status',d.status))
      FROM ops.publisher_destinations d WHERE d.environment=p.environment AND d.post_id=p.id) destinations
    FROM ops.publisher_posts p WHERE p.environment=$1
      AND (p.created_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2::date AND $3::date
      AND ($4::uuid IS NULL OR p.id=$4) AND $5=''`,'created_at DESC,id DESC',
  'Situação das publicações registradas, sem legendas, mídia ou links privados. Não publica nem agenda conteúdo.');
  if(view==='regioes')return readPage(ctx,`SELECT g.id,g.campaign_id,g.allocation,g.municipality,g.coverage,g.valid_from,g.valid_until
    FROM marketing.geography_bindings g WHERE g.environment=$1
      AND g.valid_from<=$3::date AND g.valid_until>=$2::date AND $4::uuid IS NULL AND $5=''
      AND EXISTS(SELECT 1 FROM marketing.effective_campaign_scopes s WHERE s.environment=g.environment
        AND s.ad_account_id=g.ad_account_id AND s.campaign_id=g.campaign_id AND s.scope='matrix')
      AND EXISTS(SELECT 1 FROM marketing.meta_identity_accounts ia WHERE ia.environment=g.environment AND ia.ad_account_id=g.ad_account_id)`,
  'valid_from DESC,id DESC','Regiões e cobertura configuradas para campanhas da Matriz; não presumem geolocalização de clientes.');
  if(view==='atribuicao') {
    if(!env.MARKETING_ATTRIBUTION)return {available:false,reason:'attribution_disabled'};
    // Force Matriz scope even when the panel's rollout flag is off.
    const result=await ctx.db.query(`${REALIZED_CTE} SELECT a.campaign_id,count(*)::int sales,
      sum(a.total_amount)::text revenue_brl,CASE WHEN count(*) FILTER(WHERE a.gross_margin IS NULL)=0
        THEN sum(a.gross_margin)::text ELSE NULL END gross_margin_brl,
      count(*) FILTER(WHERE a.gross_margin IS NULL)::int pending_margin_orders
      FROM attributed a JOIN realized r ON r.id=a.order_id
      WHERE EXISTS(SELECT 1 FROM marketing.meta_identity_accounts ia WHERE ia.environment=$1 AND ia.ad_account_id=a.ad_account_id)
      GROUP BY a.campaign_id ORDER BY sales DESC,a.campaign_id`,
    [env.FAREJADOR_ENV,ctx.period.from,ctx.period.to,true]);
    return {available:true,coverage:'verified_accounts_only',period:ctx.period,monetary_unit:'BRL',...pageRows(result.rows,ctx.input.pagina),
      warning:'Atribuição registrada a campanhas classificadas como Matriz. Não equivale a todas as vendas; margem pendente fica desconhecida.'};
  }
  if(view==='google') {
    if(!env.GOOGLE_ADS_ENABLED)return {available:false,reason:'google_ads_disabled'};
    const data=await readPage(ctx,`SELECT i.entity_id AS id,i.campaign_id,i.entity_level,i.metric_date,
      (i.cost_micros::numeric/1000000)::text spend_brl,i.impressions,i.clicks,i.conversions,i.collected_at
      FROM marketing.google_insights_daily i JOIN marketing.google_campaigns c ON c.environment=i.environment
        AND c.account_id=i.account_id AND c.campaign_id=i.campaign_id
      WHERE i.environment=$1 AND c.owned AND i.entity_level='campaign'
        AND i.metric_date BETWEEN $2::date AND $3::date AND $4::uuid IS NULL AND $5=''`,
    'metric_date DESC,id','Métricas Google Ads persistidas de campanhas próprias; conversão da plataforma não comprova venda do sistema.');
    return {...data,available:Number(data.total)>0,reason:Number(data.total)>0?null:'no_persisted_metrics'};
  }
  if(!env.MARKETING_META_ENABLED)return {available:false,reason:'meta_ads_disabled'};
  const data=await readPage(ctx,`SELECT i.entity_id AS id,i.campaign_id,i.metric_date,i.account_currency,
    i.spend,i.impressions,i.clicks,i.conversations,i.collected_at FROM marketing.meta_insights_daily_scoped i
    WHERE i.environment=$1 AND i.account_currency='BRL' AND i.campaign_scope='matrix' AND i.entity_level='${view==='anuncios'?'ad':'campaign'}'
      AND EXISTS(SELECT 1 FROM marketing.meta_identity_accounts ia WHERE ia.environment=i.environment AND ia.ad_account_id=i.ad_account_id)
      AND (i.entity_level='campaign' OR EXISTS(SELECT 1 FROM marketing.meta_ad_identities a
        WHERE a.environment=i.environment AND a.ad_account_id=i.ad_account_id AND a.ad_id=i.entity_id AND a.scope='matrix'))
      AND i.metric_date BETWEEN $2::date AND $3::date AND $4::uuid IS NULL AND $5=''`,
  'metric_date DESC,id','Métricas Meta persistidas em reais de campanhas classificadas como Matriz. Outras moedas não são convertidas ou somadas. Nenhuma sincronização é executada pelo Dot.');
  return {...data,available:Number(data.total)>0,reason:Number(data.total)>0?null:'no_persisted_metrics'};
}

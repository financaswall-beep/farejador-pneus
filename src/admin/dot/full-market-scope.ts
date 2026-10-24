import type { FullSource } from './full-source-model.js';
export function fullMarketScope(source:FullSource):string {
  const key=source.key;
  const verified=`EXISTS(SELECT 1 FROM marketing.meta_identity_accounts a WHERE a.environment=t.environment AND a.ad_account_id=t.ad_account_id)`;
  const campaign=`EXISTS(SELECT 1 FROM marketing.effective_campaign_scopes c WHERE c.environment=t.environment
    AND c.ad_account_id=t.ad_account_id AND c.campaign_id=t.campaign_id AND c.scope='matrix')`;
  const ad=`EXISTS(SELECT 1 FROM marketing.meta_ad_identities a WHERE a.environment=t.environment AND a.ad_account_id=t.ad_account_id AND a.ad_id=t.ad_id AND a.scope='matrix')`;
  if(key==='marketing.meta_insights_daily')return `${verified} AND t.campaign_scope='matrix'
    AND (t.entity_level='campaign' OR (t.entity_level='ad' AND EXISTS(SELECT 1 FROM marketing.meta_ad_identities a
      WHERE a.environment=t.environment AND a.ad_account_id=t.ad_account_id AND a.ad_id=t.entity_id AND a.scope='matrix')))`;
  if(['marketing.campaign_scopes','marketing.geography_bindings','marketing.geography_test_plans'].includes(key))return `${verified} AND ${campaign}`;
  if(['marketing.meta_ad_identities','marketing.meta_ad_identity_decisions','marketing.meta_pending_spend_checks','marketing.meta_pending_spend_daily'].includes(key))return `${verified} AND ${ad}`;
  if(['marketing.google_ads','marketing.google_clicks','marketing.google_insights_daily'].includes(key))return `EXISTS
    (SELECT 1 FROM marketing.google_campaigns c WHERE c.environment=t.environment AND c.account_id=t.account_id AND c.campaign_id=t.campaign_id AND c.owned)`;
  if(key==='marketing.google_campaigns')return 't.owned';
  if(['marketing.google_click_conversations','marketing.google_order_attributions'].includes(key))return `EXISTS
    (SELECT 1 FROM marketing.google_clicks x JOIN marketing.google_campaigns c ON c.environment=x.environment
      AND c.account_id=x.account_id AND c.campaign_id=x.campaign_id AND c.owned WHERE x.environment=t.environment AND x.id=t.click_id)`;
  return 'true';
}

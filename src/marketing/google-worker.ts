import { env } from '../shared/config/env.js';
import { logger } from '../shared/logger.js';
import { syncGoogleAds } from './google-sync.js';
import { reconcileGoogleAttributions } from './google-attribution.js';
import { processGoogleConversions } from './google-conversions.js';
import { GoogleAdsError } from './google-ads-client.js';

/** Falha do Google nao bloqueia vendas, normalizacao, financeiro ou coleta da Meta. */
export function startGoogleAdsWorker():()=>void {
  if(!env.GOOGLE_ADS_ENABLED) return ()=>undefined;
  let stopped=false,timer:NodeJS.Timeout|null=null,lastSync=0;
  const loop=async()=>{
    if(stopped)return;
    if(Date.now()-lastSync>=60*60*1000) {
      try {const result=await syncGoogleAds();lastSync=Date.now();logger.info(result,'Google Ads sync completed');}
      catch(error){logger.warn({code:error instanceof GoogleAdsError?error.code:'google_sync_deferred'},'Google Ads sync deferred');}
    }
    try {const result=await reconcileGoogleAttributions();logger.info(result,'Google attribution completed');}
    catch {logger.warn({code:'google_attribution_deferred'},'Google attribution deferred');}
    try {await processGoogleConversions();}
    catch(error){logger.warn({code:error instanceof GoogleAdsError?error.code:'google_conversion_deferred'},'Google conversions deferred');}
    if(!stopped)timer=setTimeout(()=>void loop(),5*60*1000);
  };
  void loop();
  return ()=>{stopped=true;if(timer)clearTimeout(timer);};
}

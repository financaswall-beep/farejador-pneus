import { googleServiceAccountTokenBody, GOOGLE_TOKEN_URL } from './google-service-account.js';
import { GoogleAdsError } from './google-ads-client.js';

export interface GooglePurchaseEvent {
  transactionId:string; eventTimestamp:string; conversionValue:number; currency:'BRL'; conversionCount:1;
  eventSource:'WEB'|'MESSAGE'; adIdentifiers:Partial<Record<'gclid'|'gbraid'|'wbraid',string>>;
  consent:{adUserData:'CONSENT_GRANTED';adPersonalization:'CONSENT_GRANTED'|'CONSENT_DENIED'};
}
export class GoogleIngestAmbiguous extends Error { constructor() {super('google_ingest_ambiguous');} }
/** Novo integrador usa Data Manager. Um POST concluido ainda nao confirma processamento. */
export async function googleDataManager(config: {serviceAccountJson:string;accountId:string;actionId:string;loginId?:string}, fetcher:typeof fetch=fetch) {
  if (!/^\d{10}$/.test(config.accountId)||!/^\d+$/.test(config.actionId)||(config.loginId&&!/^\d{10}$/.test(config.loginId))) {
    throw new GoogleAdsError('invalid_config');
  }
  let token:string;
  try {
    const response=await fetcher(GOOGLE_TOKEN_URL,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
      headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:googleServiceAccountTokenBody(config.serviceAccountJson,Date.now(),'conversions')});
    const body=await response.json() as {access_token?:unknown};
    if(!response.ok||typeof body.access_token!=='string'||!body.access_token) throw new Error();
    token=body.access_token;
  } catch {throw new GoogleAdsError('data_manager_auth_failed');}
  const destination={reference:'purchase',operatingAccount:{accountType:'GOOGLE_ADS',accountId:config.accountId},
    loginAccount:{accountType:'GOOGLE_ADS',accountId:config.loginId??config.accountId},productDestinationId:config.actionId};
  const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
  return {
    async validateDestination():Promise<void> {
      // A validação não registra conversão. Bloqueia envios até Google reconhecer a meta.
      await this.ingest({transactionId:'farejador:prod:00000000-0000-0000-0000-000000000000',
        eventTimestamp:new Date().toISOString(),conversionValue:1,currency:'BRL',conversionCount:1,eventSource:'MESSAGE',
        adIdentifiers:{gclid:'validation-only-not-a-real-click'},
        consent:{adUserData:'CONSENT_GRANTED',adPersonalization:'CONSENT_DENIED'}},true);
    },
    async ingest(event:GooglePurchaseEvent,validateOnly=false):Promise<string> {
      const identifiers=Object.entries(event.adIdentifiers);
      if (!/^farejador:(prod|test):[a-f0-9-]{36}$/.test(event.transactionId)||!Number.isFinite(Date.parse(event.eventTimestamp))
        || !Number.isFinite(event.conversionValue)||event.conversionValue<0||event.currency!=='BRL'
        || event.conversionCount!==1 || !['WEB','MESSAGE'].includes(event.eventSource)
        || !identifiers.length||identifiers.some(([k,v])=>!['gclid','gbraid','wbraid'].includes(k)||typeof v!=='string'||!/^[A-Za-z0-9_-]{1,512}$/.test(v))
        || event.consent.adUserData!=='CONSENT_GRANTED'||!['CONSENT_GRANTED','CONSENT_DENIED'].includes(event.consent.adPersonalization)) {
        throw new GoogleAdsError('invalid_conversion');
      }
      let response:Response;
      try {response=await fetcher('https://datamanager.googleapis.com/v1/events:ingest',{
        method:'POST',redirect:'error',headers,signal:AbortSignal.timeout(20000),
        body:JSON.stringify({destinations:[destination],events:[{...event,destinationReferences:[destination.reference]}],validateOnly})});}
      catch {throw new GoogleIngestAmbiguous();}
      if (!response.ok) {
        // 5xx pode ocorrer depois de receber o evento. Nao reenviar automaticamente.
        if(response.status>=500) throw new GoogleIngestAmbiguous();
        throw new GoogleAdsError(response.status===429?'data_manager_quota':'data_manager_rejected');
      }
      if(validateOnly) return '';
      try {
        const body=await response.json() as {requestId?:unknown};
        if(typeof body.requestId!=='string'||!body.requestId||body.requestId.length>1000) throw new Error();
        return body.requestId;
      } catch {throw new GoogleIngestAmbiguous();}
    },
    async status(requestId:string):Promise<'processing'|'sent'|'failed'|'review'> {
      if(!requestId||requestId.length>1000) throw new GoogleAdsError('invalid_request_id');
      try {
        const response=await fetcher(`https://datamanager.googleapis.com/v1/requestStatus:retrieve?requestId=${encodeURIComponent(requestId)}`,
          {method:'GET',redirect:'error',headers,signal:AbortSignal.timeout(15000)});
        if(!response.ok) throw new Error();
        const body=await response.json() as {requestStatusPerDestination?:Array<{destination?:typeof destination;requestStatus?:string}>};
        const rows=body.requestStatusPerDestination;
        if(!rows||rows.length!==1||rows[0]?.destination?.operatingAccount?.accountId!==config.accountId
          ||rows[0].destination.productDestinationId!==config.actionId) throw new Error();
        return ({SUCCESS:'sent',PROCESSING:'processing',FAILED:'failed',PARTIAL_SUCCESS:'review'} as const)[rows[0].requestStatus as 'SUCCESS']??'review';
      } catch {throw new GoogleAdsError('data_manager_status_unavailable');}
    },
  };
}

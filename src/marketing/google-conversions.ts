import type { Pool } from 'pg';
import { pool } from '../persistence/db.js';
import { env } from '../shared/config/env.js';
import { REALIZED_ORDERS_CTE } from './reporting.js';
import { GoogleAdsError } from './google-ads-client.js';
import { googleDataManager, GoogleIngestAmbiguous, type GooglePurchaseEvent } from './google-data-manager.js';
let destinationHealth:{state:'pending'|'ready'|'error';checked_at:string|null;code:string|null}={state:'pending',checked_at:null,code:null};
let verifiedUntil=0;
export function googleConversionHealth(){return {...destinationHealth};}

export async function processGoogleConversions(options:{dbPool?:Pool;transport?:Pick<Awaited<ReturnType<typeof googleDataManager>>,'ingest'|'status'>}={}) {
  const db=options.dbPool??pool,environment=env.FAREJADOR_ENV,action=env.GOOGLE_ADS_CONVERSION_ACTION_ID;
  if(!env.GOOGLE_ADS_CONVERSIONS_ENABLED||!action||!env.GOOGLE_ADS_CUSTOMER_ID||!env.GOOGLE_ADS_SERVICE_ACCOUNT_JSON) return {enabled:false,processed:0};
  await db.query(`${REALIZED_ORDERS_CTE} INSERT INTO marketing.google_conversion_outbox(environment,attribution_id,order_id,action_id,transaction_id)
    SELECT a.environment,a.id,a.order_id,$3,'farejador:'||a.environment::text||':'||a.order_id::text
    FROM marketing.google_order_attributions a JOIN realized r ON r.id=a.order_id
    JOIN marketing.google_clicks g ON g.environment=a.environment AND g.id=a.click_id
    JOIN marketing.google_campaigns c ON c.environment=g.environment AND c.account_id=g.account_id AND c.campaign_id=g.campaign_id
    WHERE a.environment=$1 AND a.status='active' AND a.superseded_by IS NULL AND c.owned AND g.account_id=$2
      AND g.consent_ad_user_data ON CONFLICT DO NOTHING`,[environment,env.GOOGLE_ADS_CUSTOMER_ID,action]);
  // Processo morto apos POST: nao ha prova de falha, portanto nao repetir.
  await db.query(`UPDATE marketing.google_conversion_outbox SET status='review',last_error_code='interrupted_delivery',updated_at=now()
    WHERE environment=$1 AND status='processing' AND locked_at<now()-interval '5 minutes'`,[environment]);
  const transport=options.transport??await googleDataManager({serviceAccountJson:env.GOOGLE_ADS_SERVICE_ACCOUNT_JSON,
    accountId:env.GOOGLE_ADS_CUSTOMER_ID,actionId:action,loginId:env.GOOGLE_ADS_LOGIN_CUSTOMER_ID});
  if(!options.transport && Date.now()>=verifiedUntil) {
    try {
      await (transport as Awaited<ReturnType<typeof googleDataManager>>).validateDestination();verifiedUntil=Date.now()+60*60*1000;
      destinationHealth={state:'ready',checked_at:new Date().toISOString(),code:null};
    } catch(error) {
      destinationHealth={state:'error',checked_at:new Date().toISOString(),code:error instanceof GoogleAdsError?error.code:'validation_unavailable'};
      // A configuração ainda não reconhecida mantém as vendas pendentes, sem gastar tentativas.
      return {enabled:true,processed:0,destination_ready:false};
    }
  }
  let processed=0;
  for(let i=0;i<20;i++) {
    const claimed=await db.query<{id:string;request_id:string|null;transaction_id:string;attribution_id:string;attempts:number}>(
      `WITH candidate AS(SELECT q.id FROM marketing.google_conversion_outbox q
       JOIN marketing.google_order_attributions a ON a.environment=q.environment AND a.id=q.attribution_id
       JOIN marketing.google_clicks g ON g.environment=a.environment AND g.id=a.click_id
       WHERE q.environment=$1 AND q.action_id=$2 AND g.account_id=$3 AND q.status IN ('pending','failed','accepted')
       AND q.not_before<=now() AND q.attempts<20 ORDER BY q.created_at FOR UPDATE OF q SKIP LOCKED LIMIT 1)
       UPDATE marketing.google_conversion_outbox q SET status='processing',locked_at=now(),attempts=q.attempts+1,updated_at=now()
       FROM candidate c WHERE q.id=c.id RETURNING q.id,q.request_id,q.transaction_id,q.attribution_id,q.attempts`,
    [environment,action,env.GOOGLE_ADS_CUSTOMER_ID]);
    const row=claimed.rows[0]; if(!row) break;
    let status='suppressed',requestId=row.request_id,errorCode:string|null=null;
    try {
      const eligible=await db.query<{identifier_type:'gclid'|'gbraid'|'wbraid';identifier:string;personalization:boolean;destination:'web'|'whatsapp';realized_at:string;amount:string}>(
        `${REALIZED_ORDERS_CTE} SELECT g.identifier_type,g.identifier,g.consent_ad_personalization personalization,
         g.destination,a.realized_at,o.total_amount::text amount FROM marketing.google_order_attributions a
         JOIN realized r ON r.id=a.order_id JOIN commerce.orders o ON o.environment=a.environment AND o.id=a.order_id
         JOIN marketing.google_clicks g ON g.environment=a.environment AND g.id=a.click_id
         JOIN marketing.google_campaigns c ON c.environment=g.environment AND c.account_id=g.account_id AND c.campaign_id=g.campaign_id
         WHERE a.environment=$1 AND a.id=$2 AND a.status='active' AND a.superseded_by IS NULL AND c.owned
           AND g.account_id=$3 AND g.consent_ad_user_data`,[environment,row.attribution_id,env.GOOGLE_ADS_CUSTOMER_ID]);
      const sale=eligible.rows[0];
      if(requestId) {
        // Mesmo cancelada, verificar entrega ja aceita para nao declarar "suprimida" quando foi enviada.
        const state=await transport.status(requestId);
        status=state==='processing'?'accepted':state;
        if(!sale&&status==='sent') {status='review';errorCode='sent_sale_cancelled';}
        if(status==='failed') {status='dead_letter';errorCode='data_manager_processing_failed';}
      } else if(sale) {
        const event:GooglePurchaseEvent={transactionId:row.transaction_id,eventTimestamp:new Date(sale.realized_at).toISOString(),
          conversionValue:Number(sale.amount),currency:'BRL',conversionCount:1,eventSource:sale.destination==='web'?'WEB':'MESSAGE',
          adIdentifiers:{[sale.identifier_type]:sale.identifier},consent:{adUserData:'CONSENT_GRANTED',
            adPersonalization:sale.personalization?'CONSENT_GRANTED':'CONSENT_DENIED'}};
        requestId=await transport.ingest(event);status='accepted';
      } else errorCode='sale_not_eligible';
    } catch(error) {
      errorCode=error instanceof GoogleAdsError?error.code:error instanceof GoogleIngestAmbiguous?'google_ingest_ambiguous':'google_delivery_unavailable';
      status=error instanceof GoogleIngestAmbiguous?'review':requestId?'accepted':row.attempts>=8?'dead_letter':'failed';
    }
    await db.query(`UPDATE marketing.google_conversion_outbox SET status=$3,request_id=$4,last_error_code=$5,
      not_before=now()+interval '15 minutes',locked_at=NULL,updated_at=now(),sent_at=CASE WHEN $3='sent' THEN now() ELSE sent_at END
      WHERE environment=$1 AND id=$2 AND status='processing'`,[environment,row.id,
        status==='accepted'&&row.attempts>=20?'review':status,requestId,
        status==='accepted'&&row.attempts>=20?'processing_confirmation_timeout':errorCode]);
    processed++;
  }
  // Cancelamento posterior a confirmacao exige ajuste na plataforma, visivel sem reenvio silencioso.
  await db.query(`${REALIZED_ORDERS_CTE} UPDATE marketing.google_conversion_outbox q SET status='review',last_error_code='sent_sale_cancelled',updated_at=now()
    WHERE q.environment=$1 AND q.status='sent' AND NOT EXISTS(SELECT 1 FROM realized r WHERE r.id=q.order_id)`,[environment]);
  return {enabled:true,processed};
}

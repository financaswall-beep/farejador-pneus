import type {PoolClient} from 'pg';
import type {DeliverySettings} from './matriz-delivery-settings.js';
import {businessDateSaoPaulo} from '../shared/business-time.js';
import {readWeeklyStoreHours,weeklyStoreHoursStatus} from '../shared/weekly-store-hours.js';

/** Horário de Brasília convertido por Intl; não depende do fuso do container. */
function localInstant(day:string,time:string):Date {
  let instant=new Date(day+'T'+time+':00Z');
  for(let round=0;round<2;round++){
    const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit',
      hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(instant);
    const p=(type:string)=>parts.find(part=>part.type===type)!.value;
    const shown=Date.parse(`${p('year')}-${p('month')}-${p('day')}T${p('hour')}:${p('minute')}:${p('second')}Z`);
    instant=new Date(instant.getTime()+Date.parse(day+'T'+time+':00Z')-shown);
  }
  return instant;
}
const addDays=(day:string,n:number)=>new Date(Date.parse(day+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);

export function matrizOrderWindow(settings:DeliverySettings|null,mode:'pickup'|'delivery',now=new Date()) {
  const status=weeklyStoreHoursStatus(readWeeklyStoreHours(settings?.store_hours),now);
  if(status.state==='open')return {allowed:true,notBefore:null,status};
  if(!status.next_opening)return {allowed:false,notBefore:null,status};
  const day=addDays(businessDateSaoPaulo(now),status.next_opening.days_ahead);
  const notBefore=localInstant(day,status.next_opening.opens_at);let deliveryNotBefore=notBefore;
  // Entrega segue sua janela própria; abertura da loja não promete entrega naquele minuto.
  if(mode==='delivery'&&settings?.days.length){
    for(let offset=0;offset<=7;offset++){
      const candidate=addDays(day,offset),weekday=new Date(candidate+'T12:00:00Z').getUTCDay();
      if(!settings.days.includes(weekday))continue;
      const start=localInstant(candidate,settings.opens_at??'00:00');
      const end=localInstant(candidate,settings.closes_at??'23:59');
      if(end<=notBefore)continue;
      deliveryNotBefore=new Date(Math.max(notBefore.getTime(),start.getTime()));break;
    }
  }
  return {allowed:true,notBefore,deliveryNotBefore,status};
}

/** Chamador mantém a transação da reserva. O primeiro horário gravado é preservado em retries. */
export async function saveMatrizOrderWindow(client:PoolClient,environment:string,id:string,settings:DeliverySettings|null,
 mode:'pickup'|'delivery',now=new Date()) {
  const window=matrizOrderWindow(settings,mode,now);
  if(!window.allowed)throw Error('store_hours_unknown');
  if(!window.notBefore)return null;
  const row=(await client.query<{fulfillment_not_before:Date}>(`UPDATE commerce.orders SET
    fulfillment_not_before=COALESCE(fulfillment_not_before,$3::timestamptz),
    scheduled_delivery_date=CASE WHEN fulfillment_mode='delivery' THEN GREATEST(
      COALESCE(scheduled_delivery_date,(created_at AT TIME ZONE 'America/Sao_Paulo')::date+1),
      ($4::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date) ELSE scheduled_delivery_date END
    WHERE environment=$1 AND id=$2 AND partner_order_id IS NULL RETURNING fulfillment_not_before`,
  [environment,id,window.notBefore.toISOString(),window.deliveryNotBefore?.toISOString()??window.notBefore.toISOString()])).rows[0];
  return row?.fulfillment_not_before.toISOString()??null;
}

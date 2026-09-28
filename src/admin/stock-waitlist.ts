import type { Pool } from 'pg';
import { pool } from '../persistence/db.js';
import { env } from '../shared/config/env.js';
import { buildMatrizStockIndex,matrizStockForMeasure } from '../shared/matriz-stock-source.js';
import { tireSizeKey } from '../shared/tire-size.js';

export interface WaitlistRow {
  id:string; conversation_id:string; contact_id:string; name:string; channel_type:string;
  tire_size:string; tire_condition:string; vehicle_type:string|null; quantity:number|null;
  phone_e164:string; consent_text:string; offer_text:string|null; consent_at:string;
  contacted_at:string|null; status:string; version:number; city:string|null;
  available_quantity:number; available:boolean; store_name:string; measure:string;
}
export interface WaitlistFilter { search:string; vehicle:string; region:string; status:string; offset:number }
const base=`FROM ops.stock_interests s JOIN core.conversations c
  ON c.environment=s.environment AND c.id=s.conversation_id
  JOIN core.contacts ct ON ct.id=c.contact_id AND ct.environment=c.environment AND ct.deleted_at IS NULL
  LEFT JOIN analytics.v_bot_demand_location l ON l.environment=c.environment AND l.conversation_id=c.id
  WHERE s.environment=$1 AND c.chatwoot_account_id=$2 AND c.deleted_at IS NULL`;
const fold=(v:string)=>v.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
export function displayWaitlistMeasure(size:string,type:string|null):string {
  const parts=tireSizeKey(size).split('-');
  return parts.length===3 ? (type==='car'?`${parts[0]}/${parts[1]}R${parts[2]}`:`${parts[0]}/${parts[1]}-${parts[2]}`):size;
}
export async function waitlistRows(db:Pool=pool,environment=env.FAREJADOR_ENV,account=env.CHATWOOT_ACCOUNT_ID) {
  const [interests,stock,store]=await Promise.all([
    db.query(`SELECT s.*,ct.id AS contact_id,COALESCE(NULLIF(ct.name,''),'Cliente') AS name,c.channel_type,
      l.municipio AS city,COALESCE(s.vehicle_type,commerce.catalog_vehicle_type(s.environment,s.tire_size,NULL,s.tire_condition)) AS resolved_type
      ${base} ORDER BY s.consent_at,s.id LIMIT 10001`,[environment,account]),
    db.query(`SELECT measure,brand,tire_condition,quantity_on_hand,quantity_reserved,unit_cost,
      commerce.stock_vehicle_type(environment,measure,brand,tire_condition) AS vehicle_type
      FROM commerce.wholesale_stock WHERE environment=$1`,[environment]),
    db.query(`SELECT name FROM core.units WHERE environment=$1 AND slug='main' LIMIT 1`,[environment]),
  ]);
  if(interests.rows.length>10000)throw Error('waitlist_limit');
  const index=buildMatrizStockIndex(stock.rows);
  const rows:WaitlistRow[]=interests.rows.map(row=>{
    // Conta cada variante uma vez e usa as mesmas travas da venda (incluindo custo).
    const variants=new Map<string,number>();
    if(row.resolved_type)for(const item of stock.rows) {
      if(tireSizeKey(item.measure)!==tireSizeKey(row.tire_size)||item.vehicle_type!==row.resolved_type||item.tire_condition!==row.tire_condition)continue;
      const state=matrizStockForMeasure(index,item.measure,item.brand,item.tire_condition);
      if(state.sellable)variants.set(`${state.key}|${item.brand}|${item.tire_condition}`,state.quantity_available);
    }
    const quantity=[...variants.values()].reduce((a,b)=>a+b,0);
    return {...row,vehicle_type:row.resolved_type,available_quantity:quantity,
      available:row.quantity!=null&&quantity>=row.quantity&&row.status==='pending',
      store_name:store.rows[0]?.name??'Loja principal',measure:displayWaitlistMeasure(row.tire_size,row.resolved_type)};
  });
  return rows;
}
export function waitlistReport(rows:WaitlistRow[],filter:WaitlistFilter,now=Date.now()) {
  const pending=rows.filter(r=>r.status==='pending'),ready=pending.filter(r=>r.available);
  const groups=new Map<string,{measure:string;vehicle_type:string|null;tire_condition:string;clients:Set<string>;quantity:number;unknown:number}>();
  for(const r of pending){const key=[r.tire_size,r.vehicle_type,r.tire_condition].join('|');
    if(!groups.has(key))groups.set(key,{measure:r.measure,vehicle_type:r.vehicle_type,tire_condition:r.tire_condition,clients:new Set(),quantity:0,unknown:0});
    const g=groups.get(key)!;g.clients.add(r.phone_e164);g.quantity+=r.quantity??0;g.unknown+=r.quantity==null?1:0;
  }
  const filtered=rows.filter(r=>(!filter.search||fold([r.name,r.measure,r.tire_size].join(' ')).includes(fold(filter.search)))
    &&(!filter.vehicle||r.vehicle_type===filter.vehicle)&&(!filter.region||r.city===filter.region)
    &&(filter.status==='history'?r.status!=='pending':r.status==='pending'
      &&(filter.status==='ready'?r.available:filter.status==='waiting'?!r.available:true)));
  return {summary:{clients:new Set(pending.map(r=>r.phone_e164)).size,quantity:pending.reduce((n,r)=>n+(r.quantity??0),0),
    unknown_quantity:pending.filter(r=>r.quantity==null).length,ready:new Set(ready.map(r=>r.phone_e164)).size,
    notified:rows.filter(r=>r.contacted_at&&new Date(r.contacted_at).getTime()>=now-7*86400000).length},
    counts:{all:pending.length,ready:ready.length,waiting:pending.length-ready.length},
    demand:[...groups.values()].map(g=>({...g,clients:g.clients.size})).sort((a,b)=>b.clients-a.clients||b.quantity-a.quantity).slice(0,5),
    regions:[...new Set(rows.map(r=>r.city).filter((v):v is string=>!!v))].sort(),
    rows:filtered.slice(filter.offset,filter.offset+12),total:filtered.length,offset:filter.offset,checked_at:new Date(now).toISOString()};
}
export async function changeWaitlistStatus(id:string,version:number,status:'contacted'|'cancelled',actor:string,db:Pool=pool) {
  const row=(await db.query(`UPDATE ops.stock_interests s SET status=$4,updated_by=$5
    FROM core.conversations c WHERE s.id=$3 AND s.environment=$1 AND c.id=s.conversation_id AND c.environment=s.environment
    AND c.chatwoot_account_id=$2 AND c.deleted_at IS NULL AND s.version=$6 AND s.status='pending'
    RETURNING s.id,s.status,s.version`,[env.FAREJADOR_ENV,env.CHATWOOT_ACCOUNT_ID,id,status,actor,version])).rows[0];
  if(!row)throw Error('waitlist_conflict');
  return row;
}

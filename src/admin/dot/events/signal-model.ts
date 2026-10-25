import { dotConfig } from '../config.js';
import { hash,type EventName,type Snapshot } from './model.js';

/** Stable UUID for a case, independent of counts or polling time. No business entity is created. */
export function signalId(name:string,key:string) {
 const h=hash(name+':'+key);return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
export function signal(name:EventName,key:string,reason:string,source:string,evidence:Record<string,unknown>,
 now:Date,fingerprint:unknown=evidence):Snapshot {
 return {name,kind:'signal',id:signalId(name,key),urgent:false,occurredAt:now,nextCheck:null,
  fingerprint:hash(JSON.stringify([reason,fingerprint])),data:{entity_id:signalId(name,key),kind:'signal',reason,
   status:'requer_conferencia',observed_at:now.toISOString(),source,url:dotConfig()!.origin+'/admin/painel',evidence}};
}
export function bounded<T>(rows:T[],limit=1000):T[] {
 if(rows.length>limit)throw Error('dot_signal_source_limit');return rows;
}

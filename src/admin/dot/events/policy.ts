import { env } from '../../../shared/config/env.js';

export function quietUntil(now=new Date()):Date|null {
  const start=env.DOT_EVENTS_QUIET_START_HOUR,end=env.DOT_EVENTS_QUIET_END_HOUR;
  if(start===end)return null;
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
  const hour=Number(parts.find(p=>p.type==='hour')!.value),minute=Number(parts.find(p=>p.type==='minute')!.value);
  const quiet=start<end?hour>=start&&hour<end:hour>=start||hour<end;
  if(!quiet)return null;
  const minutes=(end*60-hour*60-minute+1440)%1440;
  return new Date(now.getTime()+minutes*60_000);
}
export function retryDelay(attempt:number) { return Math.min(3600,30*2**Math.max(0,attempt-1)); }
export function retryable(status:number) { return status===429||status===408||status>=500; }

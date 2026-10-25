import type { Pool } from 'pg';
import { logger } from '../../../shared/logger.js';
import { withDotReadOnly } from '../read-only.js';
import { eventNames,type EventName,type Snapshot } from './model.js';
import { readSettings,ruleEnabled,type DotSettings } from './settings.js';
import { demandSignals,restockSignals } from './signals-stock.js';
import { quoteSignals } from './signals-quotes.js';
import { financeSignals } from './signals-finance.js';
import { marketingSignals } from './signals-marketing.js';
import { systemSignals } from './signals-system.js';
import { externalHealthId,readExternalHealth } from './external-health.js';

type Detector=(db:Pool,settings:DotSettings,now:Date)=>Promise<Snapshot[]>;
const detectors:Partial<Record<EventName,Detector>>={
 'farejador.estoque.procura':demandSignals,'farejador.estoque.disponivel':restockSignals,
 'farejador.atendimento.inconsistencia':quoteSignals,'farejador.financeiro.atencao':financeSignals,
 'farejador.marketing.atencao':marketingSignals,'farejador.sistema.atencao':systemSignals,
};
const checks=new Map<string,{checked_at:string;available:boolean;reason:string|null}>();
export function signalSourceStatus(){return Object.fromEntries(checks);}
export async function readSignals(name:EventName,db:Pool,now=new Date()):Promise<Snapshot[]> {
 const detector=detectors[name];if(!detector)return [];
 try {
  const rows=await withDotReadOnly(async reader=>{const {settings}=await readSettings(reader);
   return ruleEnabled(settings,name)?detector(reader,settings,now):[];},db);
  checks.set(name,{checked_at:now.toISOString(),available:true,reason:null});return rows;
 }catch(error){
  const known=['chatwoot_account_unavailable','central_ledger_disabled','marketing_integrations_disabled','dot_signal_source_limit','waitlist_limit'];
  const reason=error instanceof Error&&known.includes(error.message)?error.message:'source_unavailable';
  checks.set(name,{checked_at:now.toISOString(),available:false,reason});
  logger.warn({event_name:name,reason},'dot signal source unavailable');throw Error(reason);
 }
}
export async function readSignalSnapshot(name:unknown,id:string,db:Pool,now:Date) {
 if(typeof name!=='string'||!eventNames.includes(name as EventName))return null;
 if(name==='farejador.sistema.atencao'&&id===externalHealthId)return withDotReadOnly(async reader=>{
  const {settings}=await readSettings(reader);return ruleEnabled(settings,name)?readExternalHealth(reader,settings,now):null;
 },db);
 return (await readSignals(name as EventName,db,now)).find(row=>row.id===id)??null;
}
export const signalEventNames=eventNames.filter(name=>!!detectors[name]);

import { z } from 'zod';
import type { Pool } from 'pg';
import { pool } from '../../../persistence/db.js';
import { env } from '../../../shared/config/env.js';
import { eventNames,type EventName } from './model.js';

export const ruleLabels:Record<EventName,string>={
 'farejador.conversa.atualizada':'Atendimento e espera por resposta',
 'farejador.entrega.atencao':'Entregas com problema',
 'farejador.estoque.procura':'Procura recorrente sem estoque',
 'farejador.estoque.disponivel':'Estoque disponível para quem espera',
 'farejador.atendimento.inconsistencia':'Preço ou estoque para conferir',
 'farejador.financeiro.atencao':'Dinheiro e vencimentos para conferir',
 'farejador.marketing.atencao':'Campanhas sem resultado registrado',
 'farejador.sistema.atencao':'Bot e integrações com falha',
};
const integer=(min:number,max:number)=>z.number().int().min(min).max(max);
export const settingsSchema=z.object({
 paused:z.boolean(),events:z.object(Object.fromEntries(eventNames.map(name=>[name,z.boolean()])) as Record<EventName,z.ZodBoolean>).strict(),
 quiet_start:integer(0,23),quiet_end:integer(0,23),cooldown_minutes:integer(1,1440),max_per_hour:integer(1,300),
 urgent_outside_hours:z.boolean(),wait_minutes:integer(1,120),
 demand_contacts:integer(2,100),demand_hours:integer(1,168),quote_hours:integer(1,48),
 due_days:integer(0,30),marketing_spend_brl:z.number().finite().min(1).max(1000000),
 marketing_min_results:integer(1,1000),marketing_days:integer(1,30),
 system_stale_minutes:integer(5,1440),delivery_stale_hours:integer(1,168),
 delivery_without_date:z.boolean(),external_failures:integer(2,10),
}).strict();
export type DotSettings=z.infer<typeof settingsSchema>;
export function defaultSettings():DotSettings {
 return {paused:false,events:Object.fromEntries(eventNames.map(name=>[name,name==='farejador.conversa.atualizada'||name==='farejador.entrega.atencao'])) as DotSettings['events'],
  quiet_start:env.DOT_EVENTS_QUIET_START_HOUR,quiet_end:env.DOT_EVENTS_QUIET_END_HOUR,
  cooldown_minutes:env.DOT_EVENTS_COOLDOWN_MINUTES,max_per_hour:env.DOT_EVENTS_MAX_PER_HOUR,
  urgent_outside_hours:true,wait_minutes:env.DOT_EVENTS_WAIT_MINUTES,demand_contacts:3,demand_hours:24,quote_hours:6,
  due_days:3,marketing_spend_brl:100,marketing_min_results:1,marketing_days:2,
  system_stale_minutes:15,delivery_stale_hours:24,delivery_without_date:false,external_failures:3};
}
export async function readSettings(db:Pick<Pool,'query'>=pool) {
 const row=(await db.query<{settings:unknown;version:number;updated_at:Date}>(
  'SELECT settings,version,updated_at FROM network.dot_event_settings WHERE environment=$1',[env.FAREJADOR_ENV])).rows[0];
 return {settings:row?settingsSchema.parse(row.settings):defaultSettings(),version:row?.version??0,updated_at:row?.updated_at??null};
}
export function ruleEnabled(settings:DotSettings,name:EventName) {return !settings.paused&&settings.events[name]===true;}
export async function saveSettings(settings:DotSettings,version:number,personId:string,db:Pool=pool) {
 const parsed=settingsSchema.parse(settings),client=await db.connect();
 try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[env.FAREJADOR_ENV+':dot-settings']);
  const current=(await client.query('SELECT version FROM network.dot_event_settings WHERE environment=$1 FOR UPDATE',[env.FAREJADOR_ENV])).rows[0];
  if((current?.version??0)!==version)throw Error('dot_settings_conflict');
  const owner=await client.query(`SELECT p.id FROM network.partner_people p JOIN network.matriz_collaborators c
   ON c.person_id=p.id AND c.environment=p.environment AND c.revoked_at IS NULL AND c.panel_role='owner'
   WHERE p.id=$1 AND p.environment=$2 AND p.revoked_at IS NULL`,[personId,env.FAREJADOR_ENV]);
  if(!owner.rowCount)throw Error('owner_required');
  await client.query(`INSERT INTO network.dot_event_settings(environment,settings,version,updated_by)
   VALUES($1,$2,$3,$4) ON CONFLICT(environment) DO UPDATE SET settings=$2,version=$3,updated_by=$4,updated_at=now()`,
   [env.FAREJADOR_ENV,parsed,version+1,personId]);
  await client.query('INSERT INTO network.dot_event_settings_history(environment,settings,version,updated_by) VALUES($1,$2,$3,$4)',
   [env.FAREJADOR_ENV,parsed,version+1,personId]);
  const enabled=eventNames.filter(name=>ruleEnabled(parsed,name));
  await client.query(`UPDATE ops.dot_event_deliveries SET status='cancelled' WHERE environment=$1 AND status='pending'
   AND NOT(payload->>'name'=ANY($2::text[]))`,[env.FAREJADOR_ENV,enabled]);
  await client.query(`UPDATE ops.dot_monitor_targets SET due_at=LEAST(due_at,now())
   WHERE environment=$1 AND due_at IS NOT NULL`,[env.FAREJADOR_ENV]);
  await client.query('COMMIT');return {settings:parsed,version:version+1};
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

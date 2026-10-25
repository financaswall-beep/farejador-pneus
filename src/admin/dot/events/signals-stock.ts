import type { Pool } from 'pg';
import { env } from '../../../shared/config/env.js';
import { waitlistRows } from '../../stock-waitlist.js';
import { tireSizeKey } from '../../../shared/tire-size.js';
import type { DotSettings } from './settings.js';
import { bounded,signal } from './signal-model.js';

export async function demandSignals(db:Pool,settings:DotSettings,now:Date) {
 if(!env.CHATWOOT_ACCOUNT_ID)throw Error('chatwoot_account_unavailable');
 const rows=bounded((await db.query<{measure:string;municipality:string|null;condition:string|null;contacts:string[];searches:number}>(
  `SELECT s.measure,s.municipality,s.filters->>'condicao_pneu' condition,array_agg(DISTINCT c.contact_id::text ORDER BY c.contact_id::text) contacts,
   count(*)::int searches FROM ops.bot_stock_searches s JOIN core.conversations c ON c.id=s.conversation_id AND c.environment=s.environment
   JOIN core.contacts ct ON ct.id=c.contact_id AND ct.environment=c.environment AND ct.deleted_at IS NULL
   WHERE s.environment=$1 AND c.chatwoot_account_id=$2 AND c.deleted_at IS NULL
    AND s.occurred_at>=$3 AND s.occurred_at<=$4 AND jsonb_array_length(s.stores)>0
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s.stores) shop WHERE shop->>'available'='true')
   GROUP BY s.measure,s.municipality,s.filters->>'condicao_pneu' ORDER BY s.measure,s.municipality LIMIT 1001`,
  [env.FAREJADOR_ENV,env.CHATWOOT_ACCOUNT_ID,new Date(now.getTime()-settings.demand_hours*3600000),now])).rows);
 // Normalize equivalent spellings; count each contact once across repeated searches.
 const groups=new Map<string,{measure:string;municipality:string|null;condition:string|null;contacts:Set<string>}>();
 for(const row of rows){const key=JSON.stringify([tireSizeKey(row.measure),row.municipality,row.condition]);
  const group=groups.get(key)??{...row,contacts:new Set<string>()};row.contacts.forEach(id=>group.contacts.add(id));groups.set(key,group);}
 return [...groups.entries()].filter(([,g])=>g.contacts.size>=settings.demand_contacts).map(([key,g])=>
  signal('farejador.estoque.procura',key,'procura_recorrente_sem_disponibilidade_observada','ops.bot_stock_searches',
   {measure:g.measure,municipality:g.municipality,condition:g.condition,distinct_contacts:g.contacts.size,
    window_hours:settings.demand_hours,scope:'lojas_consultadas_na_busca',current_stock_check_required:true},now,[...g.contacts].sort()));
}
export async function restockSignals(db:Pool,_settings:DotSettings,now:Date) {
 if(!env.CHATWOOT_ACCOUNT_ID)throw Error('chatwoot_account_unavailable');
 const rows=await waitlistRows(db);
 return bounded(rows.filter(row=>row.available)).map(row=>signal('farejador.estoque.disponivel',row.id,
  'estoque_vendavel_para_interesse_pendente','ops.stock_interests + commerce.wholesale_stock',
  {interest_id:row.id,conversation_id:row.conversation_id,measure:row.measure,condition:row.tire_condition,
   quantity_requested:row.quantity,quantity_available:row.available_quantity,consent_at:row.consent_at,
   stock_scope:'matriz',contact_status:row.status},now,[row.id,row.version,row.quantity]));
}

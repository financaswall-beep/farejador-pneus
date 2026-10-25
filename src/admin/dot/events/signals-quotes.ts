import type { Pool } from 'pg';
import { env } from '../../../shared/config/env.js';
import type { DotSettings } from './settings.js';
import { bounded,signal } from './signal-model.js';

const blocked=new Set(['preco_alterado','partner_sale_price_missing','catalog_price_missing','estoque_insuficiente','falha_confirmacao_estoque']);
export function quoteProblems(actions:unknown) {
 if(!Array.isArray(actions))return [];
 const results:Record<string,unknown>[]=[];
 for(const action of actions) {
  if(action?.role!=='tool')continue;
  let value;try{value=typeof action.content==='string'?JSON.parse(action.content):action.content;}catch{continue;}
  if(!value||typeof value!=='object')continue;
  // A successful order later in this turn settles the blocked attempt.
  if(value.order_id||value.pedido_id||value.pedido?.id){results.length=0;continue;}
  if(blocked.has(value.erro))results.push({error:value.erro,
   items:Array.isArray(value.itens)?value.itens.filter((item:unknown)=>item&&typeof item==='object').slice(0,30).map((item:Record<string,unknown>)=>({
    product_id:typeof item.product_id==='string'?item.product_id:null,
    quoted_price:typeof item.preco_informado==='number'?item.preco_informado:null,
    current_price:typeof item.preco_atual==='number'?item.preco_atual:null})):[]});
 }
 return results;
}
export async function quoteSignals(db:Pool,settings:DotSettings,now:Date) {
 if(!env.CHATWOOT_ACCOUNT_ID)throw Error('chatwoot_account_unavailable');
 const rows=bounded((await db.query<{id:string;conversation_id:string;created_at:Date;actions:unknown}>(
  `SELECT t.id,t.conversation_id,t.created_at,t.actions FROM core.conversations c
   JOIN core.contacts ct ON ct.id=c.contact_id AND ct.environment=c.environment AND ct.deleted_at IS NULL
   JOIN LATERAL(SELECT id,conversation_id,created_at,actions FROM agent.turns
    WHERE environment=c.environment AND conversation_id=c.id AND agent_version='v2' AND status='delivered'
    ORDER BY created_at DESC,id DESC LIMIT 1) t ON true
   WHERE c.environment=$1 AND c.chatwoot_account_id=$2 AND c.deleted_at IS NULL AND c.current_status<>'resolved'
    AND t.created_at>=$3 AND t.created_at<=$4 ORDER BY t.created_at DESC LIMIT 1001`,
  [env.FAREJADOR_ENV,env.CHATWOOT_ACCOUNT_ID,new Date(now.getTime()-settings.quote_hours*3600000),now])).rows);
 return rows.flatMap(row=>{const problems=quoteProblems(row.actions);return problems.length?[signal(
  'farejador.atendimento.inconsistencia',row.conversation_id,'ferramenta_bloqueou_preco_ou_estoque','agent.turns',
  {conversation_id:row.conversation_id,turn_id:row.id,problems,
   interpretation:'Bloqueio registrado na ferramenta; conferir a resposta e o aceite do cliente. Não prova promessa incorreta no texto.'},
  now,[row.id,problems])]:[];});
}

import type { Pool } from 'pg';
import { dotChatwootAccount } from './chat-scope.js';
import type { FullSource } from './full-source-model.js';
import { fullMarketScope } from './full-market-scope.js';

export async function fullScope(db:Pool,source:FullSource,params:unknown[]):Promise<string> {
  const market=fullMarketScope(source);
  if(!source.scope)return market;
  const account=await dotChatwootAccount(db);if(!account)throw Error('chat_account_unavailable');
  params.push(account);const accountParam=`$${params.length}`;
  const condition=`c.environment=t.environment AND c.chatwoot_account_id=${accountParam} AND c.deleted_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM core.contacts contact WHERE contact.id=c.contact_id AND contact.environment=c.environment AND contact.deleted_at IS NOT NULL)`;
  if(source.scope==='conversation_self')return `t.chatwoot_account_id=${accountParam} AND t.deleted_at IS NULL`;
  if(source.scope==='contact')return `EXISTS(SELECT 1 FROM core.conversations c WHERE ${condition} AND c.contact_id=t.id)`;
  if(source.scope==='chatwoot_conversation')return `(t.conversation_id IS NULL OR EXISTS(SELECT 1 FROM core.conversations c WHERE ${condition} AND c.chatwoot_conversation_id=t.conversation_id))`;
  if(source.scope==='conversation')return `${market} AND EXISTS(SELECT 1 FROM core.conversations c WHERE ${condition} AND c.id=t.conversation_id)`;
  const joins={message:['core.messages','message_id','conversation_id'],fact:['analytics.conversation_facts','fact_id','conversation_id'],
    cart:['agent.cart_current','cart_id','conversation_id'],turn:['agent.turns','turn_id','conversation_id']} as const;
  const [table,id,conversation]=joins[source.scope];
  return `EXISTS(SELECT 1 FROM ${table} parent JOIN core.conversations c ON c.id=parent.${conversation}
    AND c.environment=parent.environment WHERE ${condition} AND parent.environment=t.environment AND parent.id=t.${id}
    ${source.scope==='message'?'AND parent.deleted_at IS NULL':''}
    ${source.scope==='message'&&source.fields.includes('conversation_id')?'AND parent.conversation_id=t.conversation_id':''})`;
}

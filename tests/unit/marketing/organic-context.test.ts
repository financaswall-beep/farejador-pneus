import {beforeEach,it,expect,vi} from 'vitest';
const flags=vi.hoisted(()=>({ORGANIC_ATTRIBUTION_ENABLED:true,CHATWOOT_ACCOUNT_ID:2,
  CHATWOOT_API_BASE_URL:'https://chat.example',CHATWOOT_API_TOKEN:'fixture'}));
vi.mock('../../../src/shared/config/env.js',()=>({env:flags}));
const bind=vi.hoisted(()=>vi.fn());
vi.mock('../../../src/marketing/organic/inbound.js',()=>({bindOrganicSource:bind}));
import {ensureOrganicContext} from '../../../src/marketing/organic/context.js';
import {classifyAtendenteError} from '../../../src/shared/repositories/ops-atendente-retry.js';
const at=new Date('2026-09-27T12:00:00Z');
function db(native:unknown=null,pending=true) {
  return {query:vi.fn(async(sql:string)=>({rows:sql.startsWith('SELECT c.chatwoot')
    ? pending?[{chatwoot_conversation_id:9,chatwoot_inbox_id:39,platform:'instagram',sent_at:at}]:[]
    :sql.startsWith('SELECT sender_id')?native?[{sender_id:native}]:[]:[{id:'first',sent_at:at}]}))};
}
beforeEach(()=>{bind.mockReset();flags.ORGANIC_ATTRIBUTION_ENABLED=true;});
it('recupera o contexto pelo identificador nativo quando a Meta ainda não normalizou',async()=>{
  const client=db(),fetcher=vi.fn(async()=>Response.json({id:9,inbox_id:39,contact_inbox:{source_id:'55'}}));
  await ensureOrganicContext(client as any,'prod','conv','trigger',fetcher);
  expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://chat.example/api/v1/accounts/2/conversations/9',expect.objectContaining({redirect:'error'}));
  expect(bind).toHaveBeenCalledWith(client,'prod',{platform:'instagram',account:'17841465774227389',
    sender:'55',conversationId:'conv',messageId:'first',at});
});
it('identidade já confirmada dispensa consulta HTTP; conversas comuns não aguardam origem',async()=>{
  const fetcher=vi.fn();
  await ensureOrganicContext(db('55') as any,'prod','conv','trigger',fetcher);
  expect(bind).toHaveBeenCalledTimes(1);
  await ensureOrganicContext(db(null,false) as any,'prod','conv','trigger',fetcher);
  expect(fetcher).not.toHaveBeenCalled();expect(bind).toHaveBeenCalledTimes(1);
});
it.each([{id:9,inbox_id:40,contact_inbox:{source_id:'55'}},{id:9,inbox_id:39,meta:{sender:{name:'João',phone_number:'21999999999'}}}])
  ('não adivinha identidade por telefone nem aceita outra caixa',async body=>{
    await expect(ensureOrganicContext(db() as any,'prod','conv','trigger',vi.fn(async()=>Response.json(body)))).rejects.toThrow('organic_context_pending');
    expect(bind).not.toHaveBeenCalled();
  });
it('espera de confirmação tem retentativa; recurso desligado não muda o atendimento',async()=>{
  expect(classifyAtendenteError(Error('organic_context_pending'))).toMatchObject({retryable:true,kind:'transient'});
  expect(classifyAtendenteError(Error('organic_private_ack_pending'))).toMatchObject({retryable:true});
  flags.ORGANIC_ATTRIBUTION_ENABLED=false;const client=db(),fetcher=vi.fn();
  await ensureOrganicContext(client as any,'prod','conv','trigger',fetcher);
  expect(client.query).not.toHaveBeenCalled();expect(fetcher).not.toHaveBeenCalled();
});

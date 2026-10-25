import { beforeAll,expect,it } from 'vitest';
let settings:typeof import('../../../src/admin/dot/events/settings.js');
beforeAll(async()=>{
 Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgres://test',CHATWOOT_HMAC_SECRET:'test',ADMIN_AUTH_TOKEN:'test',
  DOT_MCP_ENABLED:'true',DOT_MCP_PUBLIC_ORIGIN:'https://farejador.example',MARKETING_SYNC_INTERVAL_MS:'86400000'});
 settings=await import('../../../src/admin/dot/events/settings.js');
});
it('novas categorias começam desligadas; pausa prevalece e limites inválidos são rejeitados',()=>{
 const config=settings.defaultSettings();
 expect(Object.values(config.events).filter(Boolean)).toHaveLength(2);
 config.paused=true;expect(settings.ruleEnabled(config,'farejador.conversa.atualizada')).toBe(false);
 for(const change of [{max_per_hour:0},{quiet_end:24},{demand_contacts:1},{marketing_spend_brl:Infinity},{wait_minutes:'10'},{sql:'query'}])
  expect(settings.settingsSchema.safeParse({...config,...change}).success).toBe(false);
});
it('silêncio cruza meia-noite em São Paulo e horas iguais desabilitam a janela',async()=>{
 const {quietUntil}=await import('../../../src/admin/dot/events/policy.js');
 const config={...settings.defaultSettings(),quiet_start:22,quiet_end:8};
 expect(quietUntil(new Date('2026-10-25T02:00:00Z'),config)?.toISOString()).toBe('2026-10-25T11:00:00.000Z');
 expect(quietUntil(new Date('2026-10-25T12:00:00Z'),config)).toBeNull();
 expect(quietUntil(new Date('2026-10-25T02:00:00Z'),{...config,quiet_end:22})).toBeNull();
});
it('bloqueio estruturado projeta só evidência necessária e recuperação posterior o resolve',async()=>{
 const {quoteProblems}=await import('../../../src/admin/dot/events/signals-quotes.js');
 const failure={role:'tool',content:JSON.stringify({erro:'preco_alterado',customer:'SEGREDO',itens:[null,{product_id:'p',preco_atual:120,preco_informado:100,telefone:'SEGREDO'}]})};
 expect(quoteProblems([failure])).toEqual([{error:'preco_alterado',items:[{product_id:'p',quoted_price:100,current_price:120}]}]);
 expect(quoteProblems([failure,{role:'tool',content:'{"pedido_id":"ok"}'}])).toEqual([]);
 expect(quoteProblems([{role:'tool',content:'{"pedido_id":"anterior"}'},failure])).toHaveLength(1);
 expect(quoteProblems([{role:'assistant',content:failure.content},{role:'tool',content:'not json'}])).toEqual([]);
});
it('campanha usa o calendário da integração e não transforma métrica ausente em zero',async()=>{
 const {campaignAttention}=await import('../../../src/admin/dot/events/signals-marketing.js');
 const config=settings.defaultSettings(),now=new Date('2026-10-25T15:00:00Z');
 const campaign={account_id:'a',campaign_id:'c',spend:'150',results:'0',missing:0,collected_at:new Date(now.getTime()-12*3600000)};
 expect(campaignAttention(campaign,config,now)).toBe('verba_com_poucos_resultados_registrados');
 expect(campaignAttention({...campaign,collected_at:now,results:null},config,now)).toBe('conferir_rastreamento_e_atualizacao');
 expect(campaignAttention({...campaign,collected_at:now,results:'2'},config,now)).toBeNull();
 expect(campaignAttention(campaign,config,now,'google')).toBe('conferir_rastreamento_e_atualizacao');
 expect(campaignAttention({...campaign,spend:'99'},config,now)).toBeNull();
});
it('probe exige resposta de saúde válida; warning com HTTP 200 não vira queda total',async()=>{
 const {healthResponseOk}=await import('../../../src/admin/dot/events/external-cycle.js');
 for(const response of [{status:503,body:'{"status":"ok"}'},{status:302,body:''},{status:200,body:'<html>'},{status:200,body:'{"status":"error"}'}])
  expect(healthResponseOk(response)).toBe(false);
 for(const status of ['ok','degraded'])expect(healthResponseOk({status:200,body:JSON.stringify({status})})).toBe(true);
});

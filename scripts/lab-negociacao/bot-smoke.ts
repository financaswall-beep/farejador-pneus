// node --import tsx scripts/lab-negociacao/bot-smoke.ts
// Transporte local verifica o payload da API e o contrato das ferramentas, sem chave válida.
import assert from 'node:assert/strict';

Object.assign(process.env, { NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://127.0.0.1:1/unused',
  DATABASE_SSL: 'false', CHATWOOT_HMAC_SECRET: 'synthetic', ADMIN_AUTH_TOKEN: 'synthetic',
  OPENAI_MODEL: 'gpt-6.1-sol', OPENAI_API_KEY: 'synthetic',
  ROUTING_GEO: 'false', PHOTO_REQUESTS: 'false', DELIVERY_FREIGHT_FROM_PIN: 'false',
  BOT_AUDIO_ENABLED:'false', PARTNER_STOCK_CONFIRMATION:'false' });
const { runLabBotTurn, labBotInfo, configureLabProfile, LAB_SCENARIOS } = await import('./bot.js');
const { SYSTEM_PROMPT, GEO_PROMPT_BLOCK, PHOTO_PROMPT_BLOCK } = await import('../../src/atendente-v2/prompt.js');
const { labTool } = await import('./bot-fixtures.js');
const { activeToolDefinitions } = await import('../../src/atendente-v2/tools.js');
const scenario = LAB_SCENARIOS[0]!;
const history = [{ role:'user' as const, content:'Estou no Centro. Quanto custa o 110/70-13?' }];
const bodies: Record<string,any>[] = [];
const replies: Record<string,unknown>[] = [];
const fn = (name:string, args:unknown) => ({ type:'function_call', call_id:'call_'+(replies.length+1)+'_'+name,
  name, arguments: JSON.stringify(args) });
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  assert.equal(String(url), 'https://api.openai.com/v1/responses');
  assert.ok(options && typeof options.body === 'string');
  bodies.push(JSON.parse(options.body));
  assert.ok(replies.length, 'unexpected model call');
  return Response.json({status:'completed',output:[replies.shift()]});
};
try {
  replies.push(fn('buscar_produto',{medida_pneu:'110/70-13',bairro:'Centro'}));
  replies.push({type:'message',role:'assistant',content:[{type:'output_text',text:'O pneu sai por R$ 110.'}]});
  const turn = await runLabBotTurn({history,scenario});
  assert.equal(turn.text,'O pneu sai por R$ 110.');
  assert.deepEqual(turn.toolNames,['buscar_produto']);
  assert.equal(bodies[0]!.input[0].content[0].text,SYSTEM_PROMPT);
  assert.deepEqual(bodies[0]!.tools.map((t:{name:string})=>t.name),activeToolDefinitions().map(t=>t.function.name));
  assert.equal(bodies[0]!.store,false);
  assert.equal(bodies[0]!.input[1].content.includes('PARECER COMERCIAL'),false);
  const raw = JSON.parse(turn.actions[1]!.content!);
  assert.equal(raw.produtos[0].total_stock_available,100);
  const sku = raw.produtos[0].product_id;
  assert.equal(JSON.stringify(raw).includes('custo'),false);
  const advice = { decisao:'aceitar' as const, total_centavos:8000, modalidade:'retirada' as const, justificativa:'margem_interna_secreta' };
  replies.push(fn('criar_pedido',{itens:[{product_id:sku,quantidade:1,preco_unitario:80}],modalidade:'pickup',forma_pagamento:'pix'}));
  const bad = await runLabBotTurn({history:[...history,...turn.actions,{role:'assistant',content:turn.text},
    {role:'user',content:'Fecha por R$ 80?' }],scenario,advice});
  assert.equal(bad.status,'fechamento_bloqueado');
  assert.match(bad.text,/110/);
  assert.equal(JSON.parse(bad.actions[1]!.content!).preco_alterado,true);
  assert.ok(JSON.stringify(bodies.at(-1)!.input).includes('PARECER COMERCIAL'));
  assert.ok(!JSON.stringify(bodies.at(-1)!.input).includes('margem_interna_secreta'));
  assert.equal((await labTool('buscar_produto',{medida_pneu:'140/70-17',bairro:'Centro'},scenario,[]) as {encontrado:boolean}).encontrado,false);
  assert.equal((await labTool('criar_pedido',{itens:[{product_id:sku,quantidade:1,preco_unitario:110}],modalidade:'delivery',
    valor_frete:0},scenario,[]) as {erro:string}).erro,'frete_alterado');
  assert.equal((await labTool('criar_pedido',{itens:[{product_id:sku,quantidade:1,preco_unitario:110}],modalidade:'pickup'},
    scenario,[]) as {erro:string}).erro,'fechamento_indisponivel');
  assert.equal((await labTool('pedir_foto',{},scenario,[]) as {erro:string}).erro,'operacao_indisponivel_no_teste');
  assert.equal(Object.hasOwn(labBotInfo(),'OPENAI_API_KEY'),false);
  const baseline = labBotInfo();
  const enabled = { ROUTING_GEO:true, PHOTO_REQUESTS:true, DELIVERY_FREIGHT_FROM_PIN:true, BOT_AUDIO_ENABLED:true,
    PARTNER_STOCK_CONFIRMATION:true, MATRIZ_CATALOG_PHOTOS_ENABLED:true, BOT_OUTBOX:true };
  for (const invalid of [{ROUTING_GEO:true}, {...enabled, PHOTO_REQUESTS:'true'},
    {...enabled,OPENAI_API_KEY:'ignored'}, {...enabled, AGENT_V2_MAX_OUTPUT_TOKENS:1023}, {...enabled, AGENT_V2_MAX_OUTPUT_TOKENS:32769}]) {
    assert.throws(() => configureLabProfile(invalid), /invalid_lab_profile/);
    assert.deepEqual(labBotInfo(), baseline);
  }
  const profile = configureLabProfile({...enabled, AGENT_V2_MAX_OUTPUT_TOKENS:2048});
  assert.deepEqual(profile.flags, enabled);
  assert.equal(profile.maxOutputTokens,2048);
  assert.ok(profile.toolNames.includes('pedir_foto') && profile.toolNames.includes('pedir_video'));
  assert.deepEqual(activeToolDefinitions().find(t=>t.function.name==='calcular_frete')?.function.parameters.required,[]);
  replies.push(fn('pedir_foto',{}));
  replies.push({type:'message',role:'assistant',content:[{type:'output_text',text:'A foto está indisponível.'}]});
  const photo = await runLabBotTurn({history:[{role:'user',content:'Tem foto?'}],scenario});
  assert.equal(JSON.parse(photo.actions[1]!.content!).erro,'operacao_indisponivel_no_teste');
  const withProfile = bodies.at(-1)!;
  assert.equal(withProfile.input[0].content[0].text,SYSTEM_PROMPT + GEO_PROMPT_BLOCK + PHOTO_PROMPT_BLOCK);
  assert.ok(withProfile.input[1].content.includes('ÁUDIO:'));
  assert.equal(withProfile.max_output_tokens,2048);
  const restored = configureLabProfile(baseline.flags);
  assert.equal(restored.maxOutputTokens,2048); // Omitir o limite mantém o valor existente.
  assert.deepEqual(restored.toolNames,baseline.toolNames);
  assert.deepEqual(activeToolDefinitions().find(t=>t.function.name==='calcular_frete')?.function.parameters.required,['bairro']);
  console.log('OK • prompt e schemas V2, API interceptada, catálogo sintético, parecer privado, bloqueios e perfil em memória.');
} finally {
  globalThis.fetch = originalFetch;
}

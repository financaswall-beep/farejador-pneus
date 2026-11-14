import Fastify, { type FastifyInstance } from 'fastify';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, expect, it, vi } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

let db: IntegrationDb;
let app: FastifyInstance;
let cookie: string;
let person: string;
let collaborator: string;
const origin = 'https://farejador.example';
const resource = origin + '/admin/dot/mcp';
const callback = 'https://chatgpt.com/connector_platform_oauth_redirect';
const verifier = 'a'.repeat(64);
const challenge = createHash('sha256').update(verifier).digest('base64url');
const headers = () => ({ cookie, origin, host: 'farejador.example', 'x-forwarded-proto': 'https' });

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test', DATABASE_SSL: 'false',
    CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'test-emergency',
    ADMIN_BEARER_FALLBACK_ENABLED: 'true', DOT_MCP_ENABLED: 'true', DOT_MCP_PUBLIC_ORIGIN: origin,
    DOT_MCP_REDIRECT_URIS: callback, MATRIZ_CENTRAL_LEDGER: 'true', MATRIZ_CENTRAL_LEDGER_READ: 'true',MATRIZ_EXPENSES:'true',MATRIZ_LOGISTICS:'true', WHOLESALE_FINANCE:'true', WHOLESALE_STOCK_DECREMENT:'true',
  });
  db = await startPostgres();
  process.env.DATABASE_URL = db.connectionString;
  vi.resetModules();
  person = (await db.pool.query(`INSERT INTO network.partner_people(environment,username,password_hash)
    VALUES('test','dot-owner','hash-fixture') RETURNING id`)).rows[0].id;
  collaborator = (await db.pool.query(`INSERT INTO network.matriz_collaborators
    (environment,person_id,display_name,job,panel_role,job_title,work_area)
    VALUES('test',$1,'Dono teste','colaborador','owner','Dono','administrative') RETURNING id`, [person])).rows[0].id;
  const { mintMatrizAdminSessionForPerson, ADMIN_SESSION_COOKIE } = await import('../../src/admin/session.js');
  const session = await mintMatrizAdminSessionForPerson('test', person, collaborator, db.pool);
  cookie = `${ADMIN_SESSION_COOKIE}=${session!.sessionToken}`;
  const { registerDotRoutes } = await import('../../src/admin/dot/route.js');
  app = Fastify({ trustProxy: true });
  await registerDotRoutes(app);
  await app.ready();
}, 240_000);

beforeEach(async()=>{
  const {__resetRateLimit}=await import('../../src/shared/rate-limit.js');
  __resetRateLimit();
});

afterAll(async () => {
  if (app) await app.close();
  const { pool } = await import('../../src/persistence/db.js');
  await pool.end();
  if (db) await stopPostgres(db);
});

function authorization(extra: Record<string,string> = {}) {
  return '/admin/dot/authorize?' + new URLSearchParams({ client_id: 'farejador-dot', response_type: 'code',
    redirect_uri: callback, resource, scope: 'farejador.read', state: 'state-test',
    code_challenge: challenge, code_challenge_method: 'S256', ...extra });
}

async function newCode() {
  const page = await app.inject({ url: authorization(), headers: headers() });
  expect(page.statusCode).toBe(200);
  const token = page.body.match(/name="dot-request" content="([a-f0-9]{64})"/)?.[1];
  expect(token).toBeTruthy();
  const accepted = await app.inject({ method: 'POST', url: '/admin/dot/authorize', headers: headers(),
    payload: { request_token: token, decision: 'allow' } });
  expect(accepted.statusCode).toBe(200);
  const redirect = new URL(accepted.json().redirect);
  expect(redirect.origin + redirect.pathname).toBe(callback);
  expect(redirect.searchParams.get('state')).toBe('state-test');
  expect(redirect.searchParams.get('iss')).toBe(origin);
  return redirect.searchParams.get('code')!;
}

async function token(body: Record<string,string>) {
  return app.inject({ method: 'POST', url: '/admin/dot/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ client_id: 'farejador-dot', resource, ...body }).toString() });
}
async function exchange(code: string, extra: Record<string,string> = {}) {
  return token({ grant_type: 'authorization_code', code, redirect_uri: callback, code_verifier: verifier, ...extra });
}
async function rpc(access?: string, method = 'tools/list', params?: object) {
  return app.inject({ method: 'POST', url: '/admin/dot/mcp', headers: {
    host:'farejador.example',
    accept: 'application/json, text/event-stream', ...(access ? { authorization: 'Bearer ' + access } : {}),
  }, payload: { jsonrpc: '2.0', id: randomBytes(6).toString('hex'), method, ...(params ? { params } : {}) } });
}

it('discovery publica recurso, escopo de leitura e PKCE sem cadastro dinâmico', async () => {
  const discovery = (await app.inject({ url: '/.well-known/oauth-authorization-server' })).json();
  expect(discovery.issuer).toBe(origin);
  expect(discovery.code_challenge_methods_supported).toEqual(['S256']);
  expect(discovery.grant_types_supported).toEqual(['authorization_code','refresh_token']);
  expect(discovery.registration_endpoint).toBeUndefined();
  const metadata = (await app.inject({ url: '/.well-known/oauth-protected-resource/admin/dot/mcp' })).json();
  expect(metadata).toMatchObject({ resource, scopes_supported: ['farejador.read'] });
});

it('exige token específico em initialize e tools/list; cookie e token emergencial não servem', async () => {
  for (const method of ['initialize','tools/list']) expect((await rpc(undefined, method)).statusCode).toBe(401);
  expect((await rpc('test-emergency')).statusCode).toBe(401);
  const response = await app.inject({ method: 'POST', url: '/admin/dot/mcp', headers: headers(),
    payload: { jsonrpc:'2.0', id:1, method:'tools/list' } });
  expect(response.statusCode).toBe(401);
  expect(response.headers['www-authenticate']).toContain('resource_metadata=');
});

it('recusa redirects, recursos, escopos e PKCE adulterados antes de redirecionar', async () => {
  for (const extra of [{redirect_uri:'https://evil.example/callback'}, {resource:origin},
    {scope:'farejador.write'}, {code_challenge_method:'plain'}, {response_type:'token'}]) {
    const response = await app.inject({url:authorization(extra),headers:headers()});
    expect(response.statusCode).toBe(400);
    expect(response.headers.location).toBeUndefined();
  }
  const response = await app.inject({url:authorization()});
  expect(response.statusCode).toBe(303);
  expect(response.headers.location).toMatch(/^\/admin\/login\?dot_return=/);
  const duplicate=await app.inject({url:authorization({ui_locales:'pt-BR'})+'&client_id=farejador-dot',headers:headers()});
  expect(duplicate.statusCode).toBe(400);
  expect(duplicate.headers.location).toBeUndefined();
});

it('aceita ui_locales do ChatGPT e descarta extensões antes do consentimento e callback', async () => {
  const url=authorization({ui_locales:'pt-BR',login_hint:'IGNORED-HINT'});
  const login=await app.inject({url});
  expect(login.statusCode).toBe(303);
  const page=await app.inject({url,headers:headers()});
  expect(page.statusCode).toBe(200);
  const nonce=page.body.match(/name="dot-request" content="([a-f0-9]{64})"/)![1];
  const stored=await db.pool.query('SELECT request_params FROM network.dot_oauth_requests WHERE request_hash=$1',
    [createHash('sha256').update(nonce).digest('hex')]);
  expect(stored.rows[0].request_params).not.toHaveProperty('ui_locales');
  expect(stored.rows[0].request_params).not.toHaveProperty('login_hint');
  const accepted=await app.inject({method:'POST',url:'/admin/dot/authorize',headers:headers(),
    payload:{request_token:nonce,decision:'allow'}});
  expect(accepted.statusCode).toBe(200);
  const redirect=new URL(accepted.json().redirect);
  expect(redirect.origin+redirect.pathname).toBe(callback);
  expect([...redirect.searchParams.keys()].sort()).toEqual(['code','iss','state']);
  expect(redirect.searchParams.get('iss')).toBe(origin);
  expect(redirect.searchParams.get('state')).toBe('state-test');
  const exchanged=await exchange(redirect.searchParams.get('code')!);
  expect(exchanged.statusCode).toBe(200);
  expect((await rpc(exchanged.json().access_token)).statusCode).toBe(200);
});

it('consentimento exige proprietário humano, origem correta e token único ligado à sessão', async () => {
  expect((await app.inject({url:authorization(),headers:{authorization:'Bearer test-emergency'}})).statusCode).toBe(403);
  const page = await app.inject({url:authorization(),headers:headers()});
  const nonce = page.body.match(/name="dot-request" content="([a-f0-9]{64})"/)![1];
  const payload = {request_token:nonce,decision:'deny'};
  expect((await app.inject({method:'POST',url:'/admin/dot/authorize',headers:{...headers(),origin:'https://evil.example'},payload})).statusCode).toBe(403);
  expect((await app.inject({method:'POST',url:'/admin/dot/authorize',headers:headers(),payload})).statusCode).toBe(200);
  expect((await app.inject({method:'POST',url:'/admin/dot/authorize',headers:headers(),payload})).statusCode).toBe(400);
});

it('código é secreto por hash, vinculado ao recurso/PKCE e só pode ser trocado uma vez', async () => {
  const code = await newCode();
  expect((await exchange(code,{code_verifier:'b'.repeat(64)})).statusCode).toBe(400);
  expect((await exchange(code,{resource:origin})).statusCode).toBe(400);
  const results = await Promise.all([exchange(code),exchange(code)]);
  expect(results.map(r=>r.statusCode).sort()).toEqual([200,400]);
  const stored = await db.pool.query(`SELECT code_hash FROM network.dot_oauth_grants WHERE code_hash=$1`,
    [createHash('sha256').update(code).digest('hex')]);
  expect(stored.rows).toHaveLength(1);
});

it('lista as ferramentas de vencimento mesmo no modo consulta e recusa executá-las sem permissão', async () => {
  const access = (await exchange(await newCode())).json().access_token;
  const listing = (await rpc(access)).json();
  expect(listing.result.tools).toHaveLength(51);
  const writes = ['preparar_alteracao_vencimento','confirmar_alteracao_vencimento',
    'lancar_despesa_matriz','anexar_comprovante_despesa','registrar_venda_lote','registrar_venda_atacado','registrar_baixa_financeira','estornar_baixa_financeira','renegociar_parcelas_venda','criar_cobranca_servico','agendar_despesas_mensais','registrar_entrada_avulsa','estornar_entrada_avulsa','vincular_gasto_a_viagem'];
  for (const tool of listing.result.tools) {
    expect(tool.annotations.readOnlyHint).toBe(!writes.includes(tool.name));
    expect(tool.securitySchemes).toEqual([{type:'oauth2',scopes:['farejador.read']}]);
  }
  expect(listing.result.tools.find((t:{name:string})=>t.name==='anexar_comprovante_despesa')._meta['openai/fileParams']).toEqual(['arquivo']);
  for (const name of writes) {
    expect(listing.result.tools.map((tool:{name:string})=>tool.name)).toContain(name);
    const denied=(await rpc(access,'tools/call',{name,arguments:{}})).json();
    expect(denied.error.message).toContain('modo de consulta');
  }
  const invalid = (await rpc(access,'tools/call',{name:'alterar_estoque',arguments:{}})).json();
  expect(invalid.error).toBeTruthy();
  const extra = (await rpc(access,'tools/call',{name:'consultar_vendas_matriz',arguments:{environment:'prod'}})).json();
  expect(extra.result?.isError || extra.error).toBeTruthy();
  const sales = (await rpc(access,'tools/call',{name:'consultar_vendas_matriz',arguments:{periodo:'hoje'}})).json();
  expect(sales.result.isError).not.toBe(true);
  expect(sales.result.structuredContent).toMatchObject({environment:'test',currency:'BRL',timezone:'America/Sao_Paulo'});
  expect(JSON.stringify(sales)).not.toMatch(/hash-fixture|Dono teste|password_hash|phone|customer_name/);
  const detailed=(await rpc(access,'tools/call',{name:'consultar_registros_matriz',arguments:{fonte:'network.matriz_collaborators'}})).json();
  expect(detailed.result.isError).not.toBe(true);
  expect(detailed.result.structuredContent.registros).toEqual(expect.arrayContaining([expect.objectContaining({display_name:'Dono teste'})]));
  const credential=(await rpc(access,'tools/call',{name:'consultar_registros_matriz',arguments:{fonte:'network.dot_oauth_tokens'}})).json();
  expect(credential.result.isError).toBe(true);
});


it('refresh gira a credencial e reutilização revoga toda a conexão', async () => {
  const initial = (await exchange(await newCode())).json();
  const rotated = await token({grant_type:'refresh_token',refresh_token:initial.refresh_token});
  expect(rotated.statusCode).toBe(200);
  expect(rotated.json().refresh_token).not.toBe(initial.refresh_token);
  expect((await rpc(initial.access_token)).statusCode).toBe(401);
  expect((await rpc(rotated.json().access_token)).statusCode).toBe(200);
  expect((await token({grant_type:'refresh_token',refresh_token:initial.refresh_token})).statusCode).toBe(400);
  expect((await rpc(rotated.json().access_token)).statusCode).toBe(401);
});

it('revogação explícita, reset de senha e perda de papel não ressuscitam com reativação', async () => {
  const first = (await exchange(await newCode())).json();
  await app.inject({method:'POST',url:'/admin/dot/revoke',headers:{'content-type':'application/x-www-form-urlencoded'},
    payload:new URLSearchParams({client_id:'farejador-dot',token:first.refresh_token}).toString()});
  expect((await rpc(first.access_token)).statusCode).toBe(401);
  const second = (await exchange(await newCode())).json();
  await db.pool.query(`UPDATE network.partner_people SET password_hash='hash-changed' WHERE id=$1`,[person]);
  expect((await rpc(second.access_token)).statusCode).toBe(401);
  const third = (await exchange(await newCode())).json();
  await db.pool.query(`UPDATE network.matriz_collaborators SET panel_role='admin' WHERE id=$1`,[collaborator]);
  expect((await app.inject({url:authorization(),headers:headers()})).statusCode).toBe(403);
  await db.pool.query(`UPDATE network.matriz_collaborators SET panel_role='owner' WHERE id=$1`,[collaborator]);
  expect((await rpc(third.access_token)).statusCode).toBe(401);
});

it('PostgreSQL bloqueia fisicamente qualquer escrita dentro da consulta', async () => {
  const { withDotReadOnly } = await import('../../src/admin/dot/read-only.js');
  const settings=await withDotReadOnly(async read=>(await read.query(`SELECT
    current_setting('transaction_read_only') AS read_only,
    current_setting('transaction_isolation') AS isolation,
    current_setting('statement_timeout') AS statement_timeout,
    current_setting('idle_in_transaction_session_timeout') AS idle_timeout`)).rows[0],db.pool);
  expect(settings).toEqual({read_only:'on',isolation:'repeatable read',statement_timeout:'15s',idle_timeout:'20s'});
  await expect(withDotReadOnly(async read => read.query(`UPDATE network.partner_people SET username=username WHERE id=$1`,[person]),db.pool))
    .rejects.toMatchObject({code:'25006'});
  expect((await db.pool.query('SELECT 1 ok')).rows[0].ok).toBe(1);
});

it('tokens e autorizações expirados são recusados; o ambiente é imposto no banco',async()=>{
  const issued=(await exchange(await newCode())).json();
  await db.pool.query(`UPDATE network.dot_oauth_tokens SET access_expires_at=now()-interval '1 second' WHERE access_hash=$1`,
    [createHash('sha256').update(issued.access_token).digest('hex')]);
  expect((await rpc(issued.access_token)).statusCode).toBe(401);
  const grant=(await db.pool.query(`SELECT grant_id FROM network.dot_oauth_tokens WHERE refresh_hash=$1`,
    [createHash('sha256').update(issued.refresh_token).digest('hex')])).rows[0].grant_id;
  await expect(db.pool.query(`UPDATE network.dot_oauth_grants SET environment='prod' WHERE id=$1`,[grant])).rejects.toBeTruthy();
  await db.pool.query(`UPDATE network.dot_oauth_grants SET expires_at=now()-interval '1 second' WHERE id=$1`,[grant]);
  expect((await token({grant_type:'refresh_token',refresh_token:issued.refresh_token})).statusCode).toBe(400);
  const code=await newCode();
  await db.pool.query(`UPDATE network.dot_oauth_grants SET code_expires_at=now()-interval '1 second' WHERE code_hash=$1`,
    [createHash('sha256').update(code).digest('hex')]);
  expect((await exchange(code)).statusCode).toBe(400);
});

it('consentimento não pode ser reaproveitado em outra sessão da mesma pessoa',async()=>{
  const page=await app.inject({url:authorization(),headers:headers()});
  const nonce=page.body.match(/name="dot-request" content="([a-f0-9]{64})"/)![1];
  const {mintMatrizAdminSessionForPerson,ADMIN_SESSION_COOKIE}=await import('../../src/admin/session.js');
  const other=await mintMatrizAdminSessionForPerson('test',person,collaborator,db.pool);
  expect((await app.inject({method:'POST',url:'/admin/dot/authorize',
    headers:{...headers(),cookie:`${ADMIN_SESSION_COOKIE}=${other!.sessionToken}`},payload:{request_token:nonce,decision:'allow'}})).statusCode).toBe(400);
});

it('revogar e reativar o colaborador mantém a conexão antiga bloqueada',async()=>{
  const issued=(await exchange(await newCode())).json();
  await db.pool.query(`UPDATE network.matriz_collaborators SET revoked_at=now() WHERE id=$1`,[collaborator]);
  expect((await rpc(issued.access_token)).statusCode).toBe(401);
  await db.pool.query(`UPDATE network.matriz_collaborators SET revoked_at=NULL WHERE id=$1`,[collaborator]);
  expect((await rpc(issued.access_token)).statusCode).toBe(401);
});

it('rejeita lote de consultas e origem externa antes de executar ferramentas',async()=>{
  const access=(await exchange(await newCode())).json().access_token;
  expect((await app.inject({method:'POST',url:'/admin/dot/mcp',headers:{host:'farejador.example',authorization:'Bearer '+access,
    accept:'application/json, text/event-stream'},payload:[{jsonrpc:'2.0',id:1,method:'tools/list'}]})).statusCode).toBe(400);
  expect((await app.inject({method:'POST',url:'/admin/dot/mcp',headers:{host:'farejador.example',origin:'https://evil.example',
    authorization:'Bearer '+access},payload:{jsonrpc:'2.0',id:1,method:'tools/list'}})).statusCode).toBe(403);
});

it('as cinco consultas rodam contra o banco reconstruído sem alterar dados comerciais',async()=>{
  const access=(await exchange(await newCode())).json().access_token;
  const before=(await db.pool.query(`SELECT (SELECT count(*) FROM commerce.orders) orders,
    (SELECT count(*) FROM finance.matriz_ledger_transactions) ledger,
    (SELECT count(*) FROM commerce.wholesale_stock_movements) movements`)).rows[0];
  for(const name of ['consultar_resumo_matriz','consultar_vendas_matriz','consultar_estoque_matriz','consultar_entregas_matriz','consultar_financeiro_matriz']) {
    const response=(await rpc(access,'tools/call',{name,arguments:{}})).json();
    expect(response.error,name).toBeUndefined();
    expect(response.result.isError,name).not.toBe(true);
    expect(response.result.structuredContent.environment).toBe('test');
  }
  const after=(await db.pool.query(`SELECT (SELECT count(*) FROM commerce.orders) orders,
    (SELECT count(*) FROM finance.matriz_ledger_transactions) ledger,
    (SELECT count(*) FROM commerce.wholesale_stock_movements) movements`)).rows[0];
  expect(after).toEqual(before);
});

async function ownerFinanceMcp() {
  const token=(await exchange(await newCode())).json().access_token;
  const grant=(await db.pool.query('SELECT grant_id FROM network.dot_oauth_tokens WHERE access_hash=$1',
    [createHash('sha256').update(token).digest('hex')])).rows[0].grant_id;
  const permission=(enabled:boolean)=>app.inject({method:'PUT',url:'/admin/api/dot/connections/'+grant+'/finance',
    headers:headers(),payload:{enabled}});
  expect((await permission(true)).statusCode).toBe(200);
  const call=async(name:string,args:object)=>{
    const result=(await rpc(token,'tools/call',{name,arguments:args})).json();
    expect(result.error,JSON.stringify(result.error)).toBeUndefined();
    expect(result.result.isError,JSON.stringify(result.result.content)).not.toBe(true);
    return result.result.structuredContent;
  };
  return {token,permission,call};
}

it('executa com permissão financeira, repete sem duplicar e estorna apenas o pagamento selecionado',async()=>{
  const {token,permission,call}=await ownerFinanceMcp();
  const now=new Date().toISOString();
  const service={cliente:'Oficina fictícia',descricao:'Montagem',valor:965,competencia:now,vencimento:'2099-12-05',idempotency_key:randomUUID()};
  const [first,repeat]=await Promise.all([call('criar_cobranca_servico',service),call('criar_cobranca_servico',service)]);
  expect(first).toEqual(repeat);
  const pay={obligation_id:first.obligation_id,lado:'a_receber',amount:300,paid_at:now,payment_method:'Pix',cash_account:'Conta teste',idempotency_key:randomUUID()};
  const payment=await call('registrar_baixa_financeira',pay);
  expect(payment.remaining_balance).toBe('665.00');
  expect(await call('registrar_baixa_financeira',pay)).toEqual(payment);
  const reverse={pagamento_id:payment.payment_ids[0],valor_esperado:300,motivo:'Parcela incorreta',ocorrido_em:new Date().toISOString(),idempotency_key:randomUUID()};
  const invalidDestination=await rpc(token,'tools/call',{name:'estornar_baixa_financeira',arguments:{...reverse,destino:{
    obligation_id:randomUUID(),lado:'a_receber',paid_at:now,payment_method:'Pix',cash_account:'Conta teste'}}});
  expect(invalidDestination.json().result.isError).toBe(true);
  expect((await call('consultar_titulos_financeiros',{lado:'a_receber',busca:'Oficina fictícia'})).itens[0].valor).toBe('665.00');
  expect((await call('estornar_baixa_financeira',reverse)).saldo).toBe('965.00');
  const cat=(await db.pool.query("SELECT slug FROM commerce.matriz_expense_categories WHERE environment='test' AND archived_at IS NULL ORDER BY slug LIMIT 1")).rows[0].slug;
  const recurring={descricao:'Aluguel de teste',categoria:cat,valor_mensal:4500,primeiro_vencimento:'2099-01-31',meses:3,idempotency_key:randomUUID()};
  const scheduled=await call('agendar_despesas_mensais',recurring);
  expect(scheduled.parcelas.map((r:{vencimento:string})=>r.vencimento)).toEqual(['2099-01-31','2099-02-28','2099-03-31']);
  expect(await call('agendar_despesas_mensais',recurring)).toEqual(scheduled);
  expect((await call('consultar_titulos_financeiros',{lado:'a_pagar',busca:'Aluguel de teste'})).itens).toHaveLength(3);
  const {createPurchaseGroup}=await import('../../src/admin/painel/queries-purchase-groups-write.js');
  const trip=await createPurchaseGroup({name:'Viagem teste Milly',actor:'teste',idempotency_key:randomUUID()},db.pool);
  const expense={category:cat,description:'Diesel de teste',amount:180,payment_status:'pending',due_date:'2099-01-01',idempotency_key:randomUUID()};
  const expenseRow=await call('lancar_despesa_matriz',expense);
  expect((await call('vincular_gasto_a_viagem',{group_id:trip.id,expense_id:expenseRow.id,idempotency_key:randomUUID()})).vinculado).toBe(true);
  const tripData=await call('consultar_viagens_de_compra',{viagem_id:trip.id});
  expect(tripData.expenses).toEqual(expect.arrayContaining([expect.objectContaining({id:expenseRow.id})]));
  const item=(await call('consultar_titulos_financeiros',{lado:'a_pagar',busca:expenseRow.id})).itens[0];
  expect((await call('registrar_baixa_financeira',{...pay,obligation_id:item.obligation_id,lado:'a_pagar',amount:180,idempotency_key:randomUUID()})).remaining_balance).toBe('0.00');
  const jpg=await (await import('sharp')).default({create:{width:8,height:8,channels:3,background:'white'}}).jpeg().toBuffer();
  const proof={expense_id:expenseRow.id,valor_esperado:180,imagem_base64:jpg.toString('base64'),idempotency_key:randomUUID()};
  expect((await call('anexar_comprovante_despesa',proof)).expense_id).toBe(expenseRow.id);
  const income={kind:'owner_contribution',description:'Aporte de teste',amount:2000,occurred_at:now,payment_method:'pix',cash_account:'Conta teste',idempotency_key:randomUUID()};
  const entry=await call('registrar_entrada_avulsa',income);
  const day=(await import('../../src/shared/business-time.js')).businessDateSaoPaulo(new Date(now));
  const bank=await call('conferir_extrato_bancario',{de:day,ate:day,conta:'Conta teste',movimentos:[{dia:day,direcao:'entrada',valor:2000}]});
  expect(bank.comparacao[0]).toMatchObject({status:'correspondencia_unica',candidatos:[entry.id]});
  expect((await call('simular_compra_de_lote',{compra_sem_frete:2000,frete:500,gastos_adicionais:0,coletados:100,aproveitaveis:80,
    desembolso_ate_a_data:2500,ate:day})).custo_por_aproveitavel).toBe(31.25);
  await call('estornar_entrada_avulsa',{entrada_id:entry.id,reason:'Correção teste',occurred_at:new Date().toISOString(),idempotency_key:randomUUID()});
  const supplier=(await db.pool.query("INSERT INTO commerce.wholesale_suppliers(environment,name) VALUES('test','Fornecedor Milly teste') RETURNING id")).rows[0].id;
  const {registerWholesalePurchase}=await import('../../src/admin/painel/queries-fornecedores-registro.js');
  const purchase=await registerWholesalePurchase({supplier_id:supplier,items:[],lot:{description:'Lote de teste',quantity:10,total_cost:50},
    receipt_status:'received',payment_status:'paid',payment_method:'Pix',created_by:'teste',idempotency_key:randomUUID()},db.pool);
  const sale={new_customer:{name:'Cliente lote fictício'},amount:1200,description:'Lote exemplo',sold_on:day,expected_cost:10,
    allocations:[{lot_id:purchase.lot_id,quantity:2}],payment_status:'pending',due_date:'2099-12-05',
    payment_plan:{received:300,method:'Pix',installments:[{amount:450,due_date:'2099-12-05'},{amount:450,due_date:'2100-01-05'}]},idempotency_key:randomUUID()};
  const order=await call('registrar_venda_lote',sale);
  expect(await call('registrar_venda_lote',sale)).toEqual(order);
  const titles=(await call('consultar_titulos_financeiros',{lado:'a_receber',busca:order.order_id})).itens;
  expect(titles.map((t:{valor:string})=>t.valor)).toEqual(['450.00','450.00']);
  const received=await call('registrar_baixa_financeira',{...pay,obligation_id:titles[0].obligation_id,
    sale_installment:{order_id:order.order_id,number:1},amount:100,idempotency_key:randomUUID()});
  expect(received).toMatchObject({remaining_balance:'800.00',installment_remaining_balance:'350.00'});
  const agreement=await call('renegociar_parcelas_venda',{obligation_id:titles[0].obligation_id,saldo_esperado:800,
    parcelas:[{amount:800,due_date:'2100-02-05'}],idempotency_key:randomUUID()});
  expect(agreement.acordo).toMatchObject({received:400,balance:800,next_due:'2100-02-05'});
  await permission(false);
  expect((await rpc(token,'tools/call',{name:'registrar_baixa_financeira',arguments:pay})).json().error.message).toContain('modo de consulta');
});

it('registra diesel pago, anexa nota à despesa pendente e apura a viagem com compras em trânsito',async()=>{
  const {call,token}=await ownerFinanceMcp();
  const {createPurchaseGroup}=await import('../../src/admin/painel/queries-purchase-groups-write.js');
  const {registerWholesalePurchase}=await import('../../src/admin/painel/queries-fornecedores-registro.js');
  const group=await createPurchaseGroup({name:'Viagem de compra dos pneus',actor:'teste',idempotency_key:randomUUID()},db.pool);
  const other=await createPurchaseGroup({name:'Segunda viagem de compra',actor:'teste',idempotency_key:randomUUID()},db.pool);
  const trips=await call('consultar_viagens_de_compra',{status:'open'});
  expect(trips.rows.map((g:{id:string})=>g.id)).toEqual(expect.arrayContaining([group.id,other.id]));
  const purchase=await registerWholesalePurchase({group_id:group.id,new_supplier:{name:'Fornecedor viagem fictício'},
    items:[],lot:{description:'Lote de teste em trânsito',quantity:10,total_cost:750},freight_amount:70,
    receipt_status:'pending',payment_status:'pending',due_date:'2099-12-05',created_by:'teste',idempotency_key:randomUUID()},db.pool);
  const when='2026-01-02T02:30:00Z';
  const expense={category:'combustivel',amount:180,description:'Diesel da viagem teste',payment_status:'paid',
    payment_method:'Pix',cash_account:'Conta da viagem',paid_at:when,occurred_at:when,group_id:group.id,idempotency_key:randomUUID()};
  const diesel=await call('lancar_despesa_matriz',expense);
  expect(await call('lancar_despesa_matriz',expense)).toEqual(diesel);
  const summary=await call('consultar_viagens_de_compra',{viagem_id:group.id});
  expect(summary.purchases[0].id).toBe(purchase.purchase_id);
  expect(summary.summary).toMatchObject({expenses:'180.00',freight_included:'70.00',cost_per_tire:'100.00',provisional:true});
  const cash=await db.pool.query(`SELECT t.cash_on::text,t.metadata->>'cash_account' conta,e.amount::text
    FROM finance.matriz_ledger_transactions t JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id
    WHERE t.environment='test' AND t.source_id=$1 AND e.account_code='cash'`,[diesel.id]);
  expect(cash.rows).toEqual([{cash_on:'2026-01-01',conta:'Conta da viagem',amount:'180.00'}]);
  const pending=await call('lancar_despesa_matriz',{category:'combustivel',amount:180,description:'Pagar depois',
    occurred_at:when,payment_status:'pending',due_date:'2099-12-05',idempotency_key:randomUUID()});
  const jpg=await (await import('sharp')).default({create:{width:9,height:9,channels:3,background:'blue'}}).jpeg().toBuffer();
  const attachment={expense_id:pending.id,valor_esperado:180,data_esperada:'2026-01-01',imagem_base64:jpg.toString('base64'),idempotency_key:randomUUID()};
  const wrong=await rpc(token,'tools/call',{name:'anexar_comprovante_despesa',arguments:{...attachment,data_esperada:'2026-01-02'}});
  expect(wrong.json().result.isError).toBe(true);
  const receipt=await call('anexar_comprovante_despesa',attachment);
  expect(await call('anexar_comprovante_despesa',attachment)).toEqual(receipt);
  const due=await call('consultar_titulos_financeiros',{lado:'a_pagar',busca:pending.id});
  expect(due.itens).toMatchObject([{valor:'180.00',due_date:'2099-12-05'}]);
  const saved=await db.pool.query(`SELECT e.payment_status,r.id comprovante FROM commerce.matriz_expenses e
    JOIN commerce.matriz_expense_receipts r ON r.environment=e.environment AND r.expense_id=e.id WHERE e.id=$1`,[pending.id]);
  expect(saved.rows).toEqual([{payment_status:'pending',comprovante:receipt.receipt_id}]);
  const out=await db.pool.query("SELECT id FROM finance.matriz_ledger_transactions WHERE environment='test' AND source_id=$1 AND cash_on IS NOT NULL",[pending.id]);
  expect(out.rowCount).toBe(0);
});

it('preserva o acordo de lote em repetição, correção entre parcelas e estorno da entrada',async()=>{
  const {call,token}=await ownerFinanceMcp();
  const {registerWholesalePurchase}=await import('../../src/admin/painel/queries-fornecedores-registro.js');
  const lot=await registerWholesalePurchase({new_supplier:{name:'Fornecedor lote de teste'},items:[],
    lot:{description:'Lote para corrigir baixa',quantity:10,total_cost:500},payment_status:'paid',payment_method:'Pix',
    receipt_status:'received',created_by:'teste',idempotency_key:randomUUID()},db.pool);
  const day=(await import('../../src/shared/business-time.js')).businessDateSaoPaulo(new Date());
  const sale={new_customer:{name:'Comprador das parcelas de teste'},amount:1200,description:'Venda do lote',
    sold_on:day,expected_cost:100,allocations:[{lot_id:lot.lot_id,quantity:2}],payment_status:'pending',due_date:'2099-12-05',
    payment_plan:{received:300,method:'Pix',cash_account:'Conta Pix da loja',
      installments:[{amount:450,due_date:'2099-12-05'},{amount:450,due_date:'2100-01-05'}]},idempotency_key:randomUUID()};
  const writes=await Promise.all([sale,{...sale,idempotency_key:randomUUID()}].map(args=>
    rpc(token,'tools/call',{name:'registrar_venda_lote',arguments:args}).then(r=>r.json())));
  const order=writes.find(r=>r.result?.structuredContent)?.result.structuredContent;
  expect(order).toBeDefined();
  expect(writes.find(r=>r.error)?.error.data.vendas).toMatchObject([{order_id:order.order_id,acordo:{received:300,balance:900}}]);
  const agenda=async()=> (await call('consultar_titulos_financeiros',{lado:'a_receber',busca:order.order_id})).itens;
  const [first,second]=await agenda();
  const target=(part:{order_id:string;sale_installment:number})=>({order_id:part.order_id,number:part.sale_installment});
  const pay={obligation_id:first.obligation_id,lado:'a_receber',paid_at:new Date().toISOString(),payment_method:'Pix',cash_account:'Conta Pix da loja'};
  const received=await call('registrar_baixa_financeira',{...pay,sale_installment:target(first),amount:300,idempotency_key:randomUUID()});
  const fix={pagamento_id:received.payment_ids[0],valor_esperado:300,motivo:'Parcela errada',ocorrido_em:new Date().toISOString(),
    destino:{...pay,sale_installment:target(second)},idempotency_key:randomUUID()};
  const changed=await call('estornar_baixa_financeira',fix);
  expect(await call('estornar_baixa_financeira',fix)).toEqual(changed);
  expect(changed).toMatchObject({parcela_reaberta:{number:1,balance:450},baixa_corrigida:{remaining_balance:'600.00',installment_remaining_balance:'150.00'}});
  const upfront=(await db.pool.query("SELECT id,metadata->>'cash_account' conta FROM finance.matriz_ledger_transactions WHERE source_id=$1",[order.order_id+':entrada'])).rows[0];
  expect(upfront.conta).toBe('Conta Pix da loja');
  const reverse={pagamento_id:upfront.id,valor_esperado:300,motivo:'Entrada não ocorreu',ocorrido_em:new Date().toISOString(),idempotency_key:randomUUID()};
  const missing=await rpc(token,'tools/call',{name:'estornar_baixa_financeira',arguments:reverse});
  expect(missing.json().result.content[0].text).toContain('informe_o_vencimento');
  expect((await call('estornar_baixa_financeira',{...reverse,vencimento_entrada_estornada:'2100-03-05'})).saldo).toBe('900.00');
  expect((await agenda()).map((part:{valor:string})=>part.valor)).toEqual(['450.00','150.00','300.00']);
  const plan=await call('renegociar_parcelas_venda',{obligation_id:first.obligation_id,saldo_esperado:900,
    parcelas:[{amount:900,due_date:'2100-04-01'}],idempotency_key:randomUUID()});
  expect(plan.acordo).toMatchObject({received:300,balance:900});
});

it('reabre a parcela de fornecedor identificada mesmo após pagamento das parcelas seguintes',async()=>{
  const {call}=await ownerFinanceMcp();
  const {registerWholesalePurchase}=await import('../../src/admin/painel/queries-fornecedores-registro.js');
  const purchase=await registerWholesalePurchase({new_supplier:{name:'Fornecedor parcelado de teste'},items:[],
    lot:{description:'Parcelas do fornecedor',quantity:10,total_cost:1200},payment_status:'pending',receipt_status:'pending',
    installments:[{amount:965,due_date:'2099-12-05'},{amount:235,due_date:'2100-01-05'}],created_by:'teste',idempotency_key:randomUUID()},db.pool);
  const agenda=async()=> (await call('consultar_titulos_financeiros',{lado:'a_pagar',busca:purchase.purchase_id})).itens;
  const [first,second]=await agenda();
  const pay={obligation_id:first.obligation_id,lado:'a_pagar',paid_at:new Date().toISOString(),payment_method:'Pix',cash_account:'Conta teste'};
  const settle=(number:number,amount:number)=>call('registrar_baixa_financeira',{...pay,parcela_compra:number,amount,idempotency_key:randomUUID()});
  const initial=await settle(first.parcela_compra,300);
  expect(initial.installment_remaining_balance).toBe('665.00');
  await settle(second.parcela_compra,235);
  expect(await agenda()).toMatchObject([{parcela_compra:1,valor:'665.00'}]);
  await settle(first.parcela_compra,665);
  const fix=await call('estornar_baixa_financeira',{pagamento_id:initial.payment_ids[0],valor_esperado:300,
    motivo:'Pagamento registrado em duplicidade',ocorrido_em:new Date().toISOString(),idempotency_key:randomUUID()});
  expect(fix.saldo).toBe('300.00');
  expect(await agenda()).toMatchObject([{parcela_compra:1,valor:'300.00'}]);
  expect((await settle(first.parcela_compra,300)).remaining_balance).toBe('0.00');
  expect(await agenda()).toHaveLength(0);
});

it('cliente oficial MCP inicializa, lista e consulta pelo transporte HTTP',async()=>{
  const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
  const {StreamableHTTPClientTransport}=await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const access=(await exchange(await newCode())).json().access_token;
  const client=new Client({name:'dot-test',version:'1.0.0'},{capabilities:{}});
  const transport=new StreamableHTTPClientTransport(new URL(resource),{
    requestInit:{headers:{Authorization:'Bearer '+access}},
    fetch:async(url,init)=>{
      const parsed=new URL(String(url));
      const response=await app.inject({method:(init?.method??'GET') as 'GET'|'POST'|'DELETE',
        url:parsed.pathname+parsed.search,headers:{...Object.fromEntries(new Headers(init?.headers)),host:'farejador.example'},
        ...(init?.body?{payload:String(init.body)}:{})});
      return new Response(response.statusCode===202?null:response.rawPayload,{status:response.statusCode,
        headers:response.headers as Record<string,string>});
    },
  });
  try{
    await client.connect(transport);
    expect((await client.listTools()).tools).toHaveLength(51);
    const result=await client.callTool({name:'consultar_vendas_matriz',arguments:{periodo:'hoje'}});
    expect(result.isError).not.toBe(true);
  }finally{await client.close();}
});

it('refresh simultâneo não produz duas credenciais ativas',async()=>{
  const initial=(await exchange(await newCode())).json();
  const responses=await Promise.all([token({grant_type:'refresh_token',refresh_token:initial.refresh_token}),
    token({grant_type:'refresh_token',refresh_token:initial.refresh_token})]);
  expect(responses.map(r=>r.statusCode).sort()).toEqual([200,400]);
  const issued=responses.find(r=>r.statusCode===200)!.json();
  expect((await rpc(issued.access_token)).statusCode).toBe(401);
});

it('consentimento expirado, vínculo prod/test e role de parceiro são bloqueados',async()=>{
  const page=await app.inject({url:authorization(),headers:headers()});
  const nonce=page.body.match(/name="dot-request" content="([a-f0-9]{64})"/)![1];
  await db.pool.query(`UPDATE network.dot_oauth_requests SET expires_at=now()-interval '1 second' WHERE request_hash=$1`,
    [createHash('sha256').update(nonce).digest('hex')]);
  expect((await app.inject({method:'POST',url:'/admin/dot/authorize',headers:headers(),payload:{request_token:nonce,decision:'allow'}})).statusCode).toBe(400);
  await expect(db.pool.query(`INSERT INTO network.dot_oauth_requests(environment,request_hash,session_hash,person_id,collaborator_id,request_params)
    VALUES('prod',$1,'fake',$2,$3,'{}')`,[randomBytes(32).toString('hex'),person,collaborator])).rejects.toMatchObject({code:'23514'});
  const restricted=await db.pool.connect();
  try{
    await restricted.query('SET ROLE farejador_partner_app');
    await expect(restricted.query('SELECT * FROM network.dot_oauth_tokens')).rejects.toMatchObject({code:'42501'});
  }finally{await restricted.query('RESET ROLE');restricted.release();}
});

it('Milly prepara, o dono confirma e pode restaurar ou desativar a permissão', async () => {
  // O restante da suíte compartilha o IP do Fastify injetado. Inicia a janela deste cenário.
  (await import('../../src/shared/rate-limit.js')).__resetRateLimit();
  const { randomUUID } = await import('node:crypto');
  const { registerWholesaleSale } = await import('../../src/admin/painel/queries-atacado-vendas.js');
  const { changeSaleInstallmentDueDate } = await import('../../src/admin/painel/sale-installment-due-date.js');
  const { businessDateSaoPaulo } = await import('../../src/shared/business-time.js');
  const original = businessDateSaoPaulo(new Date()), next = '2099-07-05';
  const product = await db.pool.query(`INSERT INTO commerce.products(environment,product_code,product_name,product_type,brand)
    VALUES ('test','dot-review','Pneu revisão','tire','Milly') RETURNING id`);
  await db.pool.query(`INSERT INTO commerce.tire_specs(environment,product_id,tire_size,width_mm,aspect_ratio,rim_diameter)
    VALUES ('test',$1,'90/90-19',90,90,19)`,[product.rows[0].id]);
  await db.pool.query(`INSERT INTO commerce.wholesale_stock(environment,measure,brand,tire_condition,quantity_on_hand,unit_cost)
    VALUES('test','90/90-19','Milly','novo',10,20)`);
  const input={items:[{measure:'90/90-19',brand:'Milly',tire_condition:'novo',quantity:1,unit_price:100}],
    new_customer:{name:'Cliente Dot'},payment_status:'pending' as const,due_date:original,created_by:'teste',
    payment_plan:{received:0,installments:[{due_date:original,amount:100}]},idempotency_key:randomUUID()};
  const {order_id}=await registerWholesaleSale(input,db.pool);
  const access=(await exchange(await newCode())).json().access_token;
  const other=(await exchange(await newCode())).json().access_token;
  const grant=(await db.pool.query(`SELECT grant_id FROM network.dot_oauth_tokens WHERE access_hash=$1`,
    [createHash('sha256').update(access).digest('hex')])).rows[0].grant_id;
  const permission='/admin/api/dot/connections/'+grant+'/installments';
  const enable=(enabled:boolean,chat_confirmation=false)=>app.inject({method:'PUT',url:permission,headers:headers(),payload:{enabled,chat_confirmation}});
  const args={order_id,number:1,expected_due_date:original,due_date:next};
  const tool=async(name:string,args:object,token=access)=>(await rpc(token,'tools/call',{name,arguments:args})).json();
  const proposal=()=>tool('preparar_alteracao_vencimento',args);
  const confirmInChat=(proposta:string,token=access)=>tool('confirmar_alteracao_vencimento',{proposta,autorizado_pelo_dono:true},token);
  expect((await proposal()).error).toBeTruthy();
  expect((await enable(true)).statusCode).toBe(200);
  expect((await tool('preparar_alteracao_vencimento',args,other)).error).toBeTruthy();
  const found=await tool('consultar_parcelas_para_revisao',{cliente:'Cliente Dot'});
  expect(found.result.structuredContent.vendas).toEqual([expect.objectContaining({order_id})]);
  const modern=await app.inject({method:'POST',url:'/admin/dot/mcp',headers:{host:'farejador.example',authorization:'Bearer '+access,
    'mcp-protocol-version':'2026-07-28','mcp-method':'tools/list'},payload:{jsonrpc:'2.0',id:1,method:'tools/list',
    params:{_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'teste',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}}}});
  expect(modern.json().result.tools.some((t:{name:string})=>t.name==='preparar_alteracao_vencimento')).toBe(true);
  expect(modern.json().result.tools.some((t:{name:string})=>t.name==='confirmar_alteracao_vencimento')).toBe(true);
  const pending=(await proposal()).result.structuredContent;
  expect(pending).toMatchObject({status:'aguardando_confirmacao',saldo:100,cliente:'Cliente Dot'});
  expect((await proposal()).result.structuredContent.proposta).toBe(pending.proposta);
  const path=(id:string)=>'/admin/api/dot/installment-reviews/'+id;
  const submit=(id:string,action='confirm')=>app.inject({method:'POST',url:path(id)+'/'+action,headers:headers()});
  const date=async()=>(await db.pool.query('SELECT due_date::text FROM commerce.wholesale_orders WHERE id=$1',[order_id])).rows[0].due_date;
  expect((await app.inject({url:path(pending.proposta),headers:headers()})).json()).toMatchObject({status:'pendente',confirmacao:'painel'});
  expect(await date()).toBe(original);
  expect((await confirmInChat(pending.proposta)).result.isError).toBe(true);
  expect(await date()).toBe(original);
  expect((await app.inject({method:'POST',url:path(pending.proposta)+'/confirm',headers:{authorization:'Bearer '+access}})).statusCode).not.toBe(200);
  expect((await app.inject({method:'POST',url:path(pending.proposta)+'/confirm',headers:{...headers(),origin:'https://other.example'}})).statusCode).toBe(403);
  expect((await submit(pending.proposta,'restore')).statusCode).toBe(404);
  expect((await enable(false)).statusCode).toBe(200);
  expect((await enable(true)).statusCode).toBe(200);
  expect((await submit(pending.proposta)).statusCode).toBe(404);
  const expired=(await proposal()).result.structuredContent.proposta;
  await db.pool.query("UPDATE network.dot_installment_reviews SET expires_at=now()-interval '1 second' WHERE id=$1",[expired]);
  expect((await submit(expired)).statusCode).toBe(410);
  expect((await enable(true,true)).statusCode).toBe(200);
  expect((await confirmInChat(expired)).result.isError).toBe(true);
  const chatProposal=(await proposal()).result.structuredContent;
  expect(chatProposal).toMatchObject({confirmacao:'conversa',ferramenta_confirmacao:'confirmar_alteracao_vencimento'});
  expect(chatProposal.confirm_url).toBeUndefined();
  const active=chatProposal.proposta;
  const otherGrant=(await db.pool.query('SELECT grant_id FROM network.dot_oauth_tokens WHERE access_hash=$1',
    [createHash('sha256').update(other).digest('hex')])).rows[0].grant_id;
  expect((await app.inject({method:'PUT',url:'/admin/api/dot/connections/'+otherGrant+'/installments',headers:headers(),
    payload:{enabled:true,chat_confirmation:true}})).statusCode).toBe(200);
  expect((await confirmInChat(active,other)).result.isError).toBe(true);
  expect((await tool('confirmar_alteracao_vencimento',{proposta:active,autorizado_pelo_dono:false})).error).toBeTruthy();
  expect((await tool('confirmar_alteracao_vencimento',{proposta:active})).error).toBeTruthy();
  expect(await date()).toBe(original);
  expect((await app.inject({url:path(active),headers:headers()})).json()).toMatchObject({status:'pendente',confirmacao:'conversa'});
  const confirmed=await Promise.all([confirmInChat(active),confirmInChat(active)]);
  for (const response of confirmed) expect(response.result.structuredContent).toMatchObject({status:'confirmado',vencimento:next,parcela:1,saldo:100});
  expect((await submit(active)).json().status).toBe('confirmado');
  expect(await date()).toBe(next);
  const audit=async()=>(await db.pool.query(`SELECT count(*)::int n FROM audit.events WHERE entity_id=$1
    AND event_type='installment_due_date_changed'`,[order_id])).rows[0].n;
  expect(await audit()).toBe(1);
  expect((await enable(false)).statusCode).toBe(200);
  expect((await submit(active,'restore')).json().status).toBe('restaurado');
  expect((await submit(active,'restore')).json().status).toBe('restaurado');
  expect(await date()).toBe(original);
  expect(await audit()).toBe(2);
  await enable(true,true);
  expect((await tool('consultar_proposta_vencimento',{proposta:active})).result.structuredContent.status).toBe('restaurado');
  const stale=(await proposal()).result.structuredContent.proposta;
  await changeSaleInstallmentDueDate({...args,due_date:'2098-06-10',idempotency_key:randomUUID()},'outro operador',db.pool);
  expect((await submit(stale)).statusCode).toBe(409);
  expect((await confirmInChat(stale)).result.isError).toBe(true);
  expect(await date()).toBe('2098-06-10');
  const partial=(await tool('preparar_alteracao_vencimento',{...args,expected_due_date:'2098-06-10'})).result.structuredContent;
  const {settleMatrizLedgerOpenItem}=await import('../../src/admin/painel/matriz-ledger-settlement.js');
  const obligation=(await db.pool.query(`SELECT id FROM finance.matriz_ledger_transactions
    WHERE source_type='commerce.wholesale_order.revenue' AND source_id=$1`,[order_id])).rows[0].id;
  await settleMatrizLedgerOpenItem({environment:'test',obligation_id:obligation,sale_installment:{order_id,number:1},
    amount:20,payment_method:'Pix',idempotency_key:randomUUID()},db.pool);
  expect((await submit(partial.proposta)).statusCode).toBe(409);
  expect((await confirmInChat(partial.proposta)).result.isError).toBe(true);
  expect(await date()).toBe('2098-06-10');
  await enable(false);
});

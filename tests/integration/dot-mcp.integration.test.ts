import Fastify, { type FastifyInstance } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
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
    DOT_MCP_REDIRECT_URIS: callback, MATRIZ_CENTRAL_LEDGER: 'true', MATRIZ_CENTRAL_LEDGER_READ: 'true',MATRIZ_LOGISTICS:'true',
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

it('expõe somente as 30 consultas permitidas; tentativas de escrita e argumentos extras são recusados', async () => {
  const access = (await exchange(await newCode())).json().access_token;
  const listing = (await rpc(access)).json();
  expect(listing.result.tools).toHaveLength(30);
  for (const tool of listing.result.tools) {
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.securitySchemes).toEqual([{type:'oauth2',scopes:['farejador.read']}]);
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
    expect((await client.listTools()).tools).toHaveLength(30);
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

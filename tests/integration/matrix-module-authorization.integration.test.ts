import Fastify, { type FastifyInstance } from 'fastify';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

let db: IntegrationDb;
let app: FastifyInstance;
let cookie: string;
let caixaToken: string;
let collaboratorId: string;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
    CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'test-emergency-token',
    ADMIN_BEARER_FALLBACK_ENABLED: 'false', MATRIZ_EXPENSES: 'false', DATABASE_SSL: 'false',
    OPERACAO_LOJA_PORTAL: 'true',
  });
  db = await startPostgres();
  process.env.DATABASE_URL = db.connectionString;
  vi.resetModules();
  const person = (await db.pool.query(`INSERT INTO network.partner_people(environment,username)
    VALUES ('test','auditoria-restrita') RETURNING id`)).rows[0].id;
  const collab = (await db.pool.query(`INSERT INTO network.matriz_collaborators
    (environment,person_id,display_name,job,panel_role,job_title,work_area)
    VALUES ('test',$1,'Auditoria restrita','vendedor','admin','Vendedor','sales') RETURNING id`, [person])).rows[0].id;
  await db.pool.query(`INSERT INTO network.matriz_collaborator_operation_permissions
    (collaborator_id,environment,allow_vendas,allow_entregas,allow_financeiro,
     allow_resumo,allow_bot,allow_retiradas,allow_clientes,allow_compras,allow_estoque,
     allow_logistica,allow_rede,allow_marketing,allow_colaboradores,allow_catalogo)
    VALUES ($1,'test',true,false,false,false,false,false,false,false,false,false,false,false,false,false)`, [collab]);
  const { mintMatrizAdminSessionForPerson, ADMIN_SESSION_COOKIE } = await import('../../src/admin/session.js');
  collaboratorId = collab;
  caixaToken = 'cs_' + randomBytes(32).toString('hex');
  await db.pool.query(`INSERT INTO network.matriz_staff_sessions(environment,person_id,session_hash,expires_at)
    VALUES ('test',$1,$2,now()+interval '1 hour')`, [person, createHash('sha256').update(caixaToken).digest('hex')]);
  const session = await mintMatrizAdminSessionForPerson('test', person, collab, db.pool);
  expect(session?.context.modules).toEqual(['vendas']);
  cookie = `${ADMIN_SESSION_COOKIE}=${session!.sessionToken}`;
  const { registerPainelFinanceiro } = await import('../../src/admin/painel/route-financeiro.js');
  app = Fastify();
  await registerPainelFinanceiro(app);
  const { registerCaixaRoute } = await import('../../src/admin/caixa/route.js');
  await registerCaixaRoute(app);
  await app.ready();
}, 240_000);

afterAll(async () => {
  if (app) await app.close();
  const { pool } = await import('../../src/persistence/db.js');
  await pool.end();
  if (db) await stopPostgres(db);
});

it('Caixa recupera apenas venda própria, exige sessão e permissão de vendas', async () => {
  const key = randomUUID();
  const contact = (await db.pool.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id)
    VALUES ('test',818181) RETURNING id`)).rows[0].id;
  const order = (await db.pool.query(`INSERT INTO commerce.orders
    (environment,contact_id,total_amount,fulfillment_mode,status,source,seller_collaborator_id,idempotency_key)
    VALUES ('test',$1,100,'pickup','paid','walkin_balcao',$2,$3) RETURNING id`, [contact, collaboratorId, key])).rows[0].id;
  const url = '/api/caixa/vendas/por-chave/' + key;
  expect((await app.inject({url})).statusCode).toBe(401);
  const headers = {authorization: 'Bearer ' + caixaToken};
  const recovered = await app.inject({url, headers});
  expect(recovered.statusCode).toBe(200);
  expect(recovered.json()).toMatchObject({found:true,order_id:order});
  await db.pool.query('UPDATE commerce.orders SET seller_collaborator_id=NULL WHERE id=$1', [order]);
  expect((await app.inject({url, headers})).json()).toEqual({found:false});
  await db.pool.query(`UPDATE network.matriz_collaborator_operation_permissions SET allow_vendas=false
    WHERE collaborator_id=$1`, [collaboratorId]);
  expect((await app.inject({url, headers})).statusCode).toBe(403);
});

it('bloqueia leitura financeira por funcionario de vendas em URL normal e codificada', async () => {
  const regular = await app.inject({ method: 'GET', url: '/admin/api/matriz/despesas', headers: { cookie } });
  const encoded = await app.inject({ method: 'GET', url: '/admin/api/matriz/%64espesas', headers: { cookie } });
  console.log('AUTH_INDEPENDENTE', JSON.stringify({ regular: regular.statusCode, encoded: encoded.statusCode }));
  expect.soft(regular.statusCode).toBe(403);
  expect.soft(encoded.statusCode).toBe(403);
});

it('a trava de dono continua protegendo escrita pela URL codificada', async () => {
  const result = await app.inject({ method: 'POST', url: '/admin/api/matriz/%64espesas/categorias',
    headers: { cookie, 'sec-fetch-site': 'same-origin' }, payload: { label: 'Auditoria' } });
  expect(result.statusCode).toBe(403);
  expect(result.json().error).toBe('admin_forbidden_module');
});

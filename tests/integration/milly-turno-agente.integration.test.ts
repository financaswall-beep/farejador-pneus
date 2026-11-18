import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';
import { functionItem, jsonResponse, responseBody, textItem } from '../unit/atendente/responses-fixtures.js';

const notificar = vi.hoisted(() => vi.fn());
vi.mock('../../src/admin/dot/events/negotiation-live.js', () => ({ notificarConsultaMilly: notificar }));
const fetcher = vi.fn<typeof fetch>();
const productName = 'Pneu 110/70-13 de teste';
const proposta = 'Você faz R$ 80 no Pix nesse 110/70-13? Vou retirar um na Matriz.';
const publicaPadrao = 'Posso verificar outra opção dessa medida para você.';
let db: IntegrationDb, appPool: Pool, ownerId: string, productId: string;
let poll: typeof import('../../src/atendente-v2/worker.js').pollAndAttend;
let negociacao: typeof import('../../src/atendente-v2/milly-negociacao.js');
let seq = 83000;

beforeAll(async () => {
  db = await startPostgres();
  expect(new URL(db.connectionString).hostname).toBe('127.0.0.1');
  Object.assign(process.env, {
    NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: db.connectionString, DATABASE_SSL: 'false', DATABASE_POOL_MAX: '2',
    CHATWOOT_HMAC_SECRET: 'fixture', ADMIN_AUTH_TOKEN: 'fixture', OPENAI_API_KEY: 'fixture-only', OPENAI_MODEL: 'gpt-5.6-sol',
    BOT_OUTBOX: 'true', AGENT_V2_WORKER_ENABLED: 'true', AGENT_V2_CONVERSATION_IDS: '*', WHOLESALE_UNIFIED_STOCK: 'true',
    ROUTING_GEO: 'false', SATISFACTION_SURVEY: 'false', PHOTO_REQUESTS: 'false',
  });
  vi.resetModules();
  ({ pool: appPool } = await import('../../src/persistence/db.js'));
  ({ pollAndAttend: poll } = await import('../../src/atendente-v2/worker.js'));
  negociacao = await import('../../src/atendente-v2/milly-negociacao.js');
  ownerId = (await db.pool.query(`INSERT INTO network.partner_people(environment,username,password_hash)
    VALUES('test','dono-qa-turno','fixture') RETURNING id`)).rows[0].id;
  await db.pool.query(`INSERT INTO network.matriz_collaborators(environment,person_id,display_name,job,panel_role,job_title,work_area)
    VALUES('test',$1,'Dono fictício','colaborador','owner','Dono','administrative')`, [ownerId]);
  await db.pool.query(`INSERT INTO core.units(environment,slug,name) VALUES('test','main','Matriz')
    ON CONFLICT (environment,slug) DO NOTHING`);
  productId = (await db.pool.query(`INSERT INTO commerce.products(environment,product_code,product_name,product_type,brand,tire_condition)
    VALUES('test','qa-aval-turno',$1,'tire','LAB','novo') RETURNING id`, [productName])).rows[0].id;
  await db.pool.query("INSERT INTO commerce.tire_specs(environment,product_id,tire_size) VALUES('test',$1,'110/70-13')", [productId]);
  await db.pool.query("INSERT INTO commerce.matriz_product_prices(environment,product_id,price_amount) VALUES('test',$1,110)", [productId]);
  await db.pool.query(`INSERT INTO commerce.wholesale_stock(environment,measure,brand,tire_condition,quantity_on_hand,unit_cost)
    VALUES('test','110/70-13','LAB','novo',100,50)`);
}, 240000);

beforeEach(() => {
  notificar.mockReset().mockResolvedValue(true);
  fetcher.mockReset().mockRejectedValue(new Error('Chamada externa inesperada no teste sintético'));
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { vi.unstubAllGlobals(); });
afterAll(async () => {
  if (appPool) await appPool.end();
  if (db) await stopPostgres(db);
});

async function criarTurno() {
  const n = ++seq;
  const contactId = (await db.pool.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name)
    VALUES('test',$1,'Contato fictício') RETURNING id`, [n])).rows[0].id;
  const conversationId: string = (await db.pool.query(`INSERT INTO core.conversations(environment,chatwoot_account_id,
    chatwoot_conversation_id,contact_id,channel_type,current_status,started_at,last_activity_at)
    VALUES('test',1,$1,$2,'whatsapp','open',now(),now()) RETURNING id`, [n, contactId])).rows[0].id;
  const messageId: string = (await db.pool.query(`INSERT INTO core.messages(environment,conversation_id,chatwoot_conversation_id,
    chatwoot_message_id,sender_type,message_type,is_private,content,sent_at)
    VALUES('test',$1,$2,$2,'contact',0,false,$3,now()) RETURNING id`, [conversationId, n, proposta])).rows[0].id;
  const jobId: string = (await db.pool.query(`INSERT INTO ops.atendente_jobs(environment,conversation_id,trigger_message_id,status,not_before)
    VALUES('test',$1,$2,'pending',now()-interval '1 second') ON CONFLICT(environment,trigger_message_id) DO UPDATE
    SET status='pending',not_before=EXCLUDED.not_before RETURNING id`, [conversationId, messageId])).rows[0].id;
  return { conversationId, messageId, jobId };
}

async function consultarNoModelo() {
  await negociacao.definirConsultaMilly(db.pool, 'test', true, ownerId);
  const turno = await criarTurno();
  fetcher.mockResolvedValueOnce(jsonResponse(responseBody([functionItem('aval_fixture', 'consultar_milly', JSON.stringify({
    product_id: productId, quantidade: 1, modalidade: 'pickup', forma_pagamento: 'pix',
    total_proposto_centavos: 8000, municipio: 'São Gonçalo', bairro: 'Centro',
  }))])));
  await poll();
  const estado = await db.pool.query(`SELECT status, attempts, locked_by, locked_at, error_message,
    not_before>now() AS adiado FROM ops.atendente_jobs WHERE id=$1`, [turno.jobId]);
  expect(estado.rows[0]).toEqual({ status: 'pending', attempts: 0, locked_by: null, locked_at: null, error_message: null, adiado: true });
  const consulta = await negociacao.consultaDoTurnoMilly(db.pool, 'test', turno.conversationId, turno.messageId);
  expect(consulta).toMatchObject({ status: 'pending', productId, offeredTotalCents: 8000, catalogUnitCents: 11000 });
  expect(notificar).toHaveBeenCalledWith(expect.anything(), 'test', consulta!.id, turno.conversationId);
  expect(await saidas(turno.conversationId)).toEqual([]);
  return { ...turno, consultaId: consulta!.id };
}

async function retomar(jobId: string) {
  // Avança somente a fila sintética. Validades de consulta e oferta usam o relógio real do banco.
  await db.pool.query("UPDATE ops.atendente_jobs SET not_before=now()-interval '1 second' WHERE id=$1 AND status='pending'", [jobId]);
  await poll();
}
async function saidas(conversationId: string) {
  return (await db.pool.query('SELECT status,body,milly_offer_id FROM ops.outbound_messages WHERE conversation_id=$1', [conversationId])).rows;
}
function requisicaoModelo(index: number) {
  const call = fetcher.mock.calls[index];
  expect(call?.[0]).toBe('https://api.openai.com/v1/responses');
  return JSON.parse(String(call?.[1]?.body));
}

it('suspende o job sem manter o worker preso e apresenta exatamente o aval, uma única vez', async () => {
  const ocupadasNoCallback: number[] = [];
  let callbackConsultouBanco = false;
  notificar.mockImplementation(async () => {
    const ocupadas = appPool.totalCount - appPool.idleCount;
    ocupadasNoCallback.push(ocupadas);
    if (ocupadas) return true; // A asserção abaixo expõe o vazamento sem pendurar o teste.
    const consulta = await appPool.connect();
    try {
      const aval = await appPool.connect();
      try {
        await Promise.all([consulta.query('SELECT 1'), aval.query('SELECT 1')]);
        callbackConsultouBanco = true;
      } finally { aval.release(); }
    } finally { consulta.release(); }
    return true;
  });
  const turno = await consultarNoModelo();
  expect(appPool.options.max).toBe(2);
  expect(ocupadasNoCallback).toEqual([0]);
  expect(callbackConsultouBanco).toBe(true);
  expect(requisicaoModelo(0).tools).toContainEqual(expect.objectContaining({ name: 'consultar_milly' }));
  await retomar(turno.jobId);
  expect(ocupadasNoCallback).toEqual([0, 0]);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(await saidas(turno.conversationId)).toEqual([]);
  expect(await negociacao.registrarParecerMilly(db.pool, 'test', turno.consultaId,
    { decisao: 'aceitar', totalCentavos: 8000, personId: ownerId })).toBe(true);
  await retomar(turno.jobId);
  await poll();
  const oferta = await saidas(turno.conversationId);
  expect(oferta).toHaveLength(1);
  expect(oferta[0]).toMatchObject({ status: 'pending', milly_offer_id: turno.consultaId });
  expect(oferta[0].body).toMatch(/Consigo fechar 1 un\. de Pneu 110\/70-13 de teste por R\$\s80,00 no total, no Pix, para retirada na Matriz\./);
  expect(oferta[0].body).toContain('Essa condição vale até');
  expect(oferta[0].body).not.toMatch(/Milly|custo|margem|110,00|50,00/i);
  expect((await db.pool.query('SELECT status FROM ops.atendente_jobs WHERE id=$1', [turno.jobId])).rows[0].status).toBe('processed');
  expect(fetcher).toHaveBeenCalledOnce();
});

it('a mesma proposta com a chave pausada recebe o fluxo habitual', async () => {
  await negociacao.definirConsultaMilly(db.pool, 'test', false, ownerId);
  const turno = await criarTurno();
  fetcher.mockResolvedValueOnce(jsonResponse(responseBody([textItem(publicaPadrao)])));
  await poll();
  const request = requisicaoModelo(0);
  expect(request.tools).not.toContainEqual(expect.objectContaining({ name: 'consultar_milly' }));
  expect(JSON.stringify(request.input)).not.toContain('milly_closer_v1');
  expect(notificar).not.toHaveBeenCalled();
  expect(await negociacao.consultaDoTurnoMilly(db.pool, 'test', turno.conversationId, turno.messageId)).toBeNull();
  expect(await saidas(turno.conversationId)).toEqual([{ status: 'pending', body: publicaPadrao, milly_offer_id: null }]);
  expect(fetcher).toHaveBeenCalledOnce();
});

it('pausar durante a espera invalida o aval atrasado e o turno volta ao atendimento habitual', async () => {
  const turno = await consultarNoModelo();
  await negociacao.definirConsultaMilly(db.pool, 'test', false, ownerId);
  expect(await negociacao.registrarParecerMilly(db.pool, 'test', turno.consultaId,
    { decisao: 'aceitar', totalCentavos: 8000, personId: ownerId })).toBe(false);
  fetcher.mockResolvedValueOnce(jsonResponse(responseBody([textItem(publicaPadrao)])));
  await retomar(turno.jobId);
  expect(requisicaoModelo(1).tools).not.toContainEqual(expect.objectContaining({ name: 'consultar_milly' }));
  expect(await saidas(turno.conversationId)).toEqual([{ status: 'pending', body: publicaPadrao, milly_offer_id: null }]);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

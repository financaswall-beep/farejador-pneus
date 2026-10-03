import { afterAll, beforeAll, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

let db: IntegrationDb;
let poll: typeof import('../../src/normalization/worker.js').pollAndNormalize;
beforeAll(async () => {
  db = await startPostgres();
  Object.assign(process.env, { NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: db.connectionString,
    CHATWOOT_HMAC_SECRET: 'test', ADMIN_AUTH_TOKEN: 'test' });
  poll = (await import('../../src/normalization/worker.js')).pollAndNormalize;
}, 240_000);
afterAll(async () => { if (db) await stopPostgres(db); });

async function event(delivery: string, environment = 'test') {
  return (await db.pool.query(`INSERT INTO raw.raw_events
    (environment,chatwoot_delivery_id,chatwoot_signature,event_type,payload)
    VALUES ($1,$2,'fixture','contact_created','{"id":121,"name":"Fixture"}') RETURNING id,payload`,
  [environment, delivery])).rows[0];
}

it('falha transitória usa espera, recupera sem alterar payload e não toca prod', async () => {
  const target = await event('retry-transient');
  const other = await event('retry-prod', 'prod');
  let calls = 0;
  const dispatch = async () => {
    calls++;
    if (calls <= 2) throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
  };
  await poll(db.pool, dispatch);
  await poll(db.pool, dispatch);
  expect(calls).toBe(1); // não gasta as cinco tentativas no mesmo poll
  for (let n = 0; n < 2; n++) {
    await db.pool.query(`UPDATE ops.normalization_retries SET next_attempt_at=now()-interval '1 second'`);
    await poll(db.pool, dispatch);
  }
  expect(calls).toBe(3);
  const rows = (await db.pool.query(`SELECT id,processing_status,payload FROM raw.raw_events ORDER BY id`)).rows;
  expect(rows.find(r => r.id === target.id)).toMatchObject({ processing_status: 'processed', payload: target.payload });
  expect(rows.find(r => r.id === other.id)?.processing_status).toBe('pending');
  expect((await db.pool.query('SELECT last_error_code,next_attempt_at FROM ops.normalization_retries WHERE raw_event_id=$1', [target.id])).rows[0])
    .toEqual({ last_error_code: null, next_attempt_at: null });
});

it('o banco recusa estado de tentativa ligado a evento de outro ambiente', async () => {
  const target = await event('wrong-environment', 'prod');
  await expect(db.pool.query(`INSERT INTO ops.normalization_retries(environment,raw_event_id,received_at)
    SELECT 'test',id,received_at FROM raw.raw_events WHERE id=$1`, [target.id]))
    .rejects.toThrow('normalization_retry_environment_mismatch');
});

it('erro permanente para e replay explícito ganha novas tentativas', async () => {
  const target = await event('retry-permanent');
  let calls = 0;
  await poll(db.pool, async () => { calls++; throw Object.assign(new Error('bad data'), { code: '23514' }); });
  await poll(db.pool, async () => { calls++; });
  expect(calls).toBe(1);
  const { replayRawEvent } = await import('../../src/admin/replay.service.js');
  await replayRawEvent(db.pool, target.id);
  await poll(db.pool, async () => { calls++; });
  expect(calls).toBe(2);
  const retry = (await db.pool.query(`SELECT attempts FROM ops.normalization_retries WHERE raw_event_id=$1`, [target.id])).rows[0];
  expect(retry.attempts).toBe(1);
});

it('limita erros transitórios persistentes a cinco tentativas', async () => {
  const target = await event('retry-limit');
  let calls = 0;
  for (let n = 0; n < 7; n++) {
    await db.pool.query(`UPDATE ops.normalization_retries SET next_attempt_at=now()-interval '1 second'`);
    await poll(db.pool, async () => { calls++; throw Object.assign(new Error('temporary'), { code: '40001' }); });
  }
  expect(calls).toBe(5);
  expect((await db.pool.query(`SELECT processing_status FROM raw.raw_events WHERE id=$1`, [target.id])).rows[0].processing_status).toBe('failed');
});

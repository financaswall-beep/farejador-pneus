import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres';

let db: IntegrationDb;

beforeAll(async () => {
  db = await startPostgres();
  process.env.DATABASE_URL = db.connectionString;
  process.env.FAREJADOR_ENV = 'test';
  process.env.NODE_ENV = 'test';
  process.env.CHATWOOT_HMAC_SECRET = 'test-secret';
  process.env.ADMIN_AUTH_TOKEN = 'admin-test-token-1234567890';
}, 180_000);

afterAll(async () => { if (db) await stopPostgres(db); });

async function queries() {
  return import('../../src/admin/painel/queries.js');
}

describe('Etapa 6 — aprovação de candidatura', () => {
  it('retry concorrente cria exatamente uma unidade e um evento', async () => {
    const q = await queries();
    const suffix = randomUUID().slice(0, 8);
    const app = await q.createPartnerApplication({
      environment: 'test', trade_name: `Candidatura ${suffix}`, municipios: 'Niterói',
    }, db.pool);
    const input = {
      application_id: app.id, actor_label: 'teste', municipios: ['Niterói'],
      idempotency_key: `approve-${suffix}`, commission_percent: 5,
    };

    const results = await Promise.all([
      q.approvePartnerApplication(input, db.pool),
      q.approvePartnerApplication(input, db.pool),
    ]);
    expect(new Set(results.map((r) => r.partner_unit_id)).size).toBe(1);
    expect(results.filter((r) => r.token).length).toBe(1);

    const facts = await db.pool.query<{
      units: number; events: number; operations: number; status: string;
    }>(
      `SELECT
        (SELECT count(*)::int FROM network.partner_units WHERE source_application_id=$1) AS units,
        (SELECT count(*)::int FROM audit.events WHERE entity_id=$1 AND event_type='partner_application_approved') AS events,
        (SELECT count(*)::int FROM audit.operation_idempotency
          WHERE domain='partner_application.approve' AND idempotency_key=$2) AS operations,
        (SELECT status FROM network.partner_applications WHERE id=$1) AS status`,
      [app.id, input.idempotency_key],
    );
    expect(facts.rows[0]).toEqual({ units: 1, events: 1, operations: 1, status: 'approved' });
  });

  it('nova chave depois de aprovado devolve a mesma unidade sem recriar token', async () => {
    const q = await queries();
    const suffix = randomUUID().slice(0, 8);
    const app = await q.createPartnerApplication({
      environment: 'test', trade_name: `Retry ${suffix}`,
    }, db.pool);
    const first = await q.approvePartnerApplication({
      application_id: app.id, actor_label: 'teste', municipios: ['Maricá'],
      idempotency_key: `approve-first-${suffix}`,
    }, db.pool);
    const second = await q.approvePartnerApplication({
      application_id: app.id, actor_label: 'teste', municipios: ['Maricá'],
      idempotency_key: `approve-second-${suffix}`,
    }, db.pool);
    expect(second.partner_unit_id).toBe(first.partner_unit_id);
    expect(second.token).toBeUndefined();
    expect(second.credential_reissue_required).toBe(true);
    const reissueKey = `reissue-${suffix}`;
    const reissued = await q.reissuePartnerCredential({
      partner_unit_id: first.partner_unit_id!, actor_label: 'teste',
      reason: 'resposta original perdida', idempotency_key: reissueKey,
      environment: 'test',
    }, db.pool);
    expect(reissued.token).toHaveLength(64);
    const reissueReplay = await q.reissuePartnerCredential({
      partner_unit_id: first.partner_unit_id!, actor_label: 'teste',
      reason: 'resposta original perdida', idempotency_key: reissueKey,
      environment: 'test',
    }, db.pool);
    expect(reissueReplay).toMatchObject({ token_id: reissued.token_id,
      replayed: true, credential_reissue_required: true });
    expect(reissueReplay.token).toBeUndefined();
    const count = await db.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM network.partner_units WHERE source_application_id=$1', [app.id]);
    expect(count.rows[0]?.n).toBe(1);
    const credentialFacts = await db.pool.query<{ active: number; events: number }>(
      `SELECT
        (SELECT count(*)::int FROM network.partner_access_tokens
          WHERE partner_unit_id=$1 AND revoked_at IS NULL) AS active,
        (SELECT count(*)::int FROM audit.events
          WHERE entity_id=$1 AND event_type='partner_credential_reissued') AS events`,
      [first.partner_unit_id]);
    expect(credentialFacts.rows[0]).toEqual({ active: 1,events: 1 });
  });
});

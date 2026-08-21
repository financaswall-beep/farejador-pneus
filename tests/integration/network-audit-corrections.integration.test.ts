import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPartnerFixture } from './helpers/partner-fixtures';
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

describe('auditoria da Rede — prova integrada', () => {
  it('consome e reemite só a chave bruta, preservando a sessão da conta', async () => {
    const fixture = await createPartnerFixture(db.pool);
    const before = await db.pool.query(
      'SELECT * FROM network.validate_partner_token($1,$2,$3)',
      ['test', fixture.slug, fixture.tokenPlain],
    );
    expect(before.rowCount).toBe(1);

    await db.pool.query(
      `INSERT INTO network.partner_sessions
         (environment,token_id,session_hash,expires_at)
       VALUES ('test',$1,$2,now()+interval '1 day')`,
      [fixture.tokenId, 'a'.repeat(64)],
    );
    await db.pool.query(
      'UPDATE network.partner_access_tokens SET raw_access_consumed_at=now() WHERE id=$1',
      [fixture.tokenId],
    );
    const consumed = await db.pool.query(
      'SELECT * FROM network.validate_partner_token($1,$2,$3)',
      ['test', fixture.slug, fixture.tokenPlain],
    );
    expect(consumed.rowCount).toBe(0);
    await expect(db.pool.query(
      'UPDATE network.partner_access_tokens SET raw_access_consumed_at=NULL WHERE id=$1',
      [fixture.tokenId],
    )).rejects.toThrow(/partner_raw_access_consumption_immutable/);

    const { reissuePartnerCredential } = await import('../../src/admin/painel/queries-candidaturas.js');
    const replacement = await reissuePartnerCredential({
      partner_unit_id: fixture.partnerUnitId,
      actor_label: 'owner teste',
      reason: 'prova de reemissão segura',
      idempotency_key: `reissue-${randomUUID()}`,
    }, db.pool);
    const validReplacement = await db.pool.query(
      'SELECT * FROM network.validate_partner_token($1,$2,$3)',
      ['test', fixture.slug, replacement.token],
    );
    expect(validReplacement.rowCount).toBe(1);
    const session = await db.pool.query<{ revoked_at: string | null }>(
      'SELECT revoked_at FROM network.partner_sessions WHERE token_id=$1',
      [fixture.tokenId],
    );
    expect(session.rows[0]?.revoked_at).toBeNull();
  });

  it('repete cadastro sem duplicar parceiro nem revelar novamente a chave', async () => {
    const { createPartnerUnit } = await import('../../src/admin/painel/queries-parceiros.js');
    const suffix = randomUUID().slice(0, 8);
    const input = {
      environment: 'test' as const,
      idempotency_key: `partner-create-${randomUUID()}`,
      trade_name: `Parceiro idempotente ${suffix}`,
      commercial_model: 'commission' as const,
      commission_percent: 0,
      monthly_fee: null,
      municipios: ['Niterói'],
      actor_label: 'owner teste',
    };
    const first = await createPartnerUnit(input, db.pool);
    const replay = await createPartnerUnit(input, db.pool);
    expect(first.token).toHaveLength(64);
    expect(replay).toMatchObject({
      partner_id: first.partner_id,
      partner_unit_id: first.partner_unit_id,
      replayed: true,
      credential_reissue_required: true,
    });
    expect(replay.token).toBeUndefined();
    const count = await db.pool.query<{ total: number }>(
      'SELECT count(*)::int AS total FROM network.partners WHERE id=$1',
      [first.partner_id],
    );
    expect(count.rows[0]?.total).toBe(1);
  });

  it('inclui despesas independentes e usa mensalidade realmente aberta no livro', async () => {
    const fixture = await createPartnerFixture(db.pool);
    await db.pool.query(
      `UPDATE network.partners SET commercial_model='monthly',commission_percent=NULL,
         monthly_fee=150 WHERE id=$1`,
      [fixture.partnerId],
    );
    await db.pool.query(
      `INSERT INTO finance.partner_expenses
         (environment,unit_id,category,description,amount,created_by)
       VALUES ('test',$1,'other','Despesa direta',10,'teste')`,
      [fixture.unitId],
    );
    await db.pool.query(
      `INSERT INTO finance.partner_payables
         (environment,unit_id,description,category,amount,status,created_by)
       VALUES ('test',$1,'Folha independente','employee',20,'open','teste')`,
      [fixture.unitId],
    );
    await db.pool.query(
      `INSERT INTO finance.matriz_partner_monthly_fees
         (environment,partner_id,competence,amount,due_date)
       VALUES ('test',$1,date_trunc('month',now())::date,150,current_date+5)`,
      [fixture.partnerId],
    );

    const { getPainelRede } = await import('../../src/admin/painel/queries-rede.js');
    const rows = await getPainelRede('month', db.pool) as Array<Record<string, unknown>>;
    const row = rows.find((item) => item.partner_unit_id === fixture.partnerUnitId);
    expect(Number(row?.expenses_month)).toBe(30);
    expect(Number(row?.employee_total)).toBe(20);
    expect(Number(row?.other_expenses_total)).toBe(10);
    expect(Number(row?.monthly_fee_open_total)).toBe(150);
  });

  it('separa tentativas atribuídas das conversas ainda sem unidade', async () => {
    const fixture = await createPartnerFixture(db.pool);
    const assigned = await db.pool.query<{ id: string }>(
      `INSERT INTO core.conversations
         (environment,chatwoot_conversation_id,chatwoot_account_id,current_status,started_at)
       VALUES ('test',$1,1,'open',now()) RETURNING id`,
      [Math.floor(Math.random() * 1_000_000_000)],
    );
    const unassigned = await db.pool.query<{ id: string }>(
      `INSERT INTO core.conversations
         (environment,chatwoot_conversation_id,chatwoot_account_id,current_status,started_at)
       VALUES ('test',$1,1,'open',now()) RETURNING id`,
      [Math.floor(Math.random() * 1_000_000_000) + 1_000_000_000],
    );
    await db.pool.query(
      `INSERT INTO ops.partner_routing_decisions
         (environment,conversation_id,unit_id,decision_kind,municipio,modality)
       VALUES ('test',$1,$2,'partner','Niterói','delivery'),
              ('test',$3,NULL,'unresolved','Maricá','delivery')`,
      [assigned.rows[0]!.id, fixture.unitId, unassigned.rows[0]!.id],
    );
    const { getRedeFunnel } = await import('../../src/admin/painel/queries-rede-resumo.js');
    const funnel = await getRedeFunnel('month', db.pool);
    expect(funnel.rows.find((row) => row.unit_id === fixture.unitId)).toMatchObject({
      tentou: 1,pediu: 0,efetivou: 0,
    });
    expect(funnel.unassigned).toBe(1);
  });
});

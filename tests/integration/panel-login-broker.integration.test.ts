import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres';
import { createPartnerFixture } from './helpers/partner-fixtures';

let db: IntegrationDb;

beforeAll(async () => {
  db = await startPostgres();
  Object.assign(process.env, {
    DATABASE_URL: db.connectionString, FAREJADOR_ENV: 'test', NODE_ENV: 'test',
    CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'test-admin-token',
  });
}, 180_000);

afterAll(async () => {
  if (db) await stopPostgres(db);
});

describe('broker do painel único', () => {
  it('emite ps_ para parceiro e mantém a unidade resolvida no servidor', async () => {
    const fixture = await createPartnerFixture(db.pool);
    const queries = await import('../../src/parceiro/queries.js');
    await queries.setOwnPartnerCredentials(
      fixture.ctx, `dono-${fixture.slug}`, 'senha-segura-123', true,
    );
    const { authenticatePanelAccess } = await import('../../src/admin/caixa/operation-auth.js');
    const broker = await authenticatePanelAccess(
      'test', `dono-${fixture.slug}`, 'senha-segura-123', db.pool,
    );

    expect(broker?.workplaces).toHaveLength(1);
    expect(broker?.workplaces[0]).toMatchObject({
      kind: 'partner', slug: fixture.slug, tokenId: fixture.tokenId,
    });
    const workplace = broker!.workplaces[0]!;
    if (workplace.kind !== 'partner') throw new Error('partner_workplace_expected');
    const session = await queries.mintPartnerSession('test', workplace.tokenId);
    expect(session.session_token).toMatch(/^ps_[a-f0-9]{64}$/);
  });

  it('só emite ms_ quando o vínculo atual possui panel_role', async () => {
    const { hashPassword } = await import('../../src/parceiro/password.js');
    const passwordHash = await hashPassword('senha-matriz-123');
    const person = await db.pool.query<{ id: string }>(
      `INSERT INTO network.partner_people(environment,username,password_hash,password_set_at)
       VALUES ('test','gestor.matriz',$1,now()) RETURNING id`,
      [passwordHash],
    );
    const collaborator = await db.pool.query<{ id: string }>(
      `INSERT INTO network.matriz_collaborators
         (environment,person_id,display_name,job,job_title,work_area,panel_role)
       VALUES ('test',$1,'Gestor','colaborador','Gestor','administrative','admin')
       RETURNING id`,
      [person.rows[0]!.id],
    );
    const { authenticatePanelAccess } = await import('../../src/admin/caixa/operation-auth.js');
    const { mintMatrizAdminSessionForPerson } = await import('../../src/admin/session.js');
    const broker = await authenticatePanelAccess(
      'test', 'gestor.matriz', 'senha-matriz-123', db.pool,
    );
    const workplace = broker!.workplaces[0]!;
    if (workplace.kind !== 'matrix') throw new Error('matrix_workplace_expected');
    const session = await mintMatrizAdminSessionForPerson(
      'test', broker!.personId, collaborator.rows[0]!.id, db.pool,
    );

    expect(session?.sessionToken).toMatch(/^ms_[a-f0-9]{64}$/);
    await db.pool.query(
      `UPDATE network.matriz_collaborators SET panel_role=NULL WHERE id=$1`,
      [collaborator.rows[0]!.id],
    );
    await expect(mintMatrizAdminSessionForPerson(
      'test', broker!.personId, collaborator.rows[0]!.id, db.pool,
    )).resolves.toBeNull();
  });
});

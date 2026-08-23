import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditPartnerGrants } from '../../scripts/grants-parceiro-contract';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres';

let db: IntegrationDb;

beforeAll(async () => {
  db = await startPostgres();
}, 180_000);

afterAll(async () => {
  if (db) await stopPostgres(db);
});

describe('contrato de privilégios do parceiro', () => {
  it('mantém exatamente os 70 grants aprovados e nenhuma permissão sensível', async () => {
    const audit = await auditPartnerGrants(db.pool);

    expect(audit).toMatchObject({
      ok: true,
      roleExists: true,
      roleSafe: true,
      baselineValid: true,
      expectedCount: 70,
      actualCount: 70,
      missingGrants: [],
      unexpectedGrants: [],
      sensitivePrivileges: [],
    });
    expect(audit.actualSha256).toBe(audit.expectedSha256);
  });

  it('reprova um grant direto numa tabela exclusiva da Matriz', async () => {
    await db.pool.query(
      'GRANT SELECT ON commerce.wholesale_stock TO farejador_partner_app',
    );
    try {
      const audit = await auditPartnerGrants(db.pool);
      expect(audit.ok).toBe(false);
      expect(audit.unexpectedGrants).toContain('commerce.wholesale_stock:SELECT:NO');
      expect(audit.sensitivePrivileges).toEqual(expect.arrayContaining([
        expect.objectContaining({
          relation: 'commerce.wholesale_stock', scope: 'table', privilege: 'SELECT',
        }),
      ]));
    } finally {
      await db.pool.query(
        'REVOKE SELECT ON commerce.wholesale_stock FROM farejador_partner_app',
      );
    }
  });

  it('reprova o vazamento escondido por privilégio numa única coluna', async () => {
    await db.pool.query(
      'GRANT SELECT (quantity_on_hand) ON commerce.wholesale_stock TO farejador_partner_app',
    );
    try {
      const audit = await auditPartnerGrants(db.pool);
      expect(audit.ok).toBe(false);
      expect(audit.unexpectedGrants).toEqual([]);
      expect(audit.sensitivePrivileges).toEqual(expect.arrayContaining([
        expect.objectContaining({
          relation: 'commerce.wholesale_stock', scope: 'column', privilege: 'SELECT',
        }),
      ]));
    } finally {
      await db.pool.query(
        'REVOKE SELECT (quantity_on_hand) ON commerce.wholesale_stock FROM farejador_partner_app',
      );
    }
  });
});

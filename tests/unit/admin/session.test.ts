import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

let validHash: string;
let authenticateMatrizAdmin: typeof import('../../../src/admin/session.js').authenticateMatrizAdmin;
let mintMatrizAdminSessionForPerson: typeof import('../../../src/admin/session.js').mintMatrizAdminSessionForPerson;
let isMatrizAdminSessionToken: typeof import('../../../src/admin/session.js').isMatrizAdminSessionToken;
let validateMatrizAdminSession: typeof import('../../../src/admin/session.js').validateMatrizAdminSession;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test', FAREJADOR_ENV: 'prod', DATABASE_URL: 'postgres://test',
    CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'emergency-token',
  });
  const password = await import('../../../src/parceiro/password.js');
  const session = await import('../../../src/admin/session.js');
  validHash = await password.hashPassword('uma-senha-forte-123');
  ({ authenticateMatrizAdmin, mintMatrizAdminSessionForPerson,
    isMatrizAdminSessionToken, validateMatrizAdminSession } = session);
});

describe('matriz admin session', () => {
  it('authenticates an active panel user and stores only the session hash', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        person_id: 'person-1', password_hash: validHash, collaborator_id: 'collab-1',
        display_name: 'Wallace', username: 'wallace.matriz', panel_role: 'owner',
      }] })
      .mockResolvedValueOnce({ rows: [] });
    const result = await authenticateMatrizAdmin(
      'prod', 'wallace.matriz', 'uma-senha-forte-123', { query } as unknown as Pool,
    );

    expect(result?.sessionToken).toMatch(/^ms_[a-f0-9]{64}$/);
    expect(result?.context).toMatchObject({ displayName: 'Wallace', role: 'owner' });
    const insertParams = query.mock.calls[1]![1] as unknown[];
    expect(insertParams[2]).toMatch(/^[a-f0-9]{64}$/);
    expect(insertParams[2]).not.toBe(result?.sessionToken);
  });

  it('rejects a valid password when the person has no panel role', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      person_id: 'person-1', password_hash: validHash, collaborator_id: null,
      display_name: null, username: 'sem-painel', panel_role: null,
    }] });

    await expect(authenticateMatrizAdmin(
      'prod', 'sem-painel', 'uma-senha-forte-123', { query } as unknown as Pool,
    )).resolves.toBeNull();
    expect(query).toHaveBeenCalledOnce();
  });

  it('never mints ms_ for a broker workplace without panel_role', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await expect(mintMatrizAdminSessionForPerson(
      'prod', 'person-1', 'collab-1', { query } as unknown as Pool,
    )).resolves.toBeNull();
    expect(query).toHaveBeenCalledOnce();
    expect(String(query.mock.calls[0]![0])).toContain('mc.panel_role IS NOT NULL');
  });

  it('validates ms_ sessions and returns the current database role', async () => {
    const token = `ms_${'a'.repeat(64)}`;
    const query = vi.fn().mockResolvedValue({ rows: [{
      person_id: 'person-1', collaborator_id: 'collab-1', display_name: 'Wallace',
      username: 'wallace.matriz', panel_role: 'admin',
    }] });

    await expect(validateMatrizAdminSession('prod', token, { query } as unknown as Pool))
      .resolves.toMatchObject({ authType: 'session', role: 'admin' });
    expect(query.mock.calls[0]![1]?.[0]).not.toBe(token);
  });

  it.each(['ps_', 'cs_', 'es_'])('rejects the %s session prefix without querying the database', async (prefix) => {
    const query = vi.fn();
    const token = `${prefix}${'a'.repeat(64)}`;
    expect(isMatrizAdminSessionToken(token)).toBe(false);
    await expect(validateMatrizAdminSession('prod', token, { query } as unknown as Pool))
      .resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
});

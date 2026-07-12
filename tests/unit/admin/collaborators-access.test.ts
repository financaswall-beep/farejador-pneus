import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

// 2026-07-12: o ciclo de acesso saiu de queries-colaboradores.ts pra fatia
// queries-colaboradores-acesso.ts (teto de 300 da obra); o teste segue a função.
let updateRole: typeof import('../../../src/admin/painel/queries-colaboradores-acesso.js').updateMatrizCollaboratorPanelRole;
let LastOwnerError: typeof import('../../../src/admin/painel/queries-colaboradores-acesso.js').MatrizLastOwnerError;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test', FAREJADOR_ENV: 'prod', DATABASE_URL: 'postgres://test',
    CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'emergency-token',
  });
  const module = await import('../../../src/admin/painel/queries-colaboradores-acesso.js');
  updateRole = module.updateMatrizCollaboratorPanelRole;
  LastOwnerError = module.MatrizLastOwnerError;
});

function poolWith(query: ReturnType<typeof vi.fn>): Pool {
  return { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) } as unknown as Pool;
}

describe('matrix collaborator panel access', () => {
  it('does not allow removing the last active owner', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ person_id: 'p1', panel_role: 'owner' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'c1' }] })
      .mockResolvedValueOnce({}); // ROLLBACK

    await expect(updateRole(
      { id: 'c1', panel_role: null, environment: 'prod' }, poolWith(query),
    )).rejects.toBeInstanceOf(LastOwnerError);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('SET panel_role'))).toBe(false);
  });

  it('revokes live sessions immediately when panel access changes', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ person_id: 'p2', panel_role: 'admin' }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({}); // COMMIT

    await expect(updateRole(
      { id: 'c2', panel_role: null, environment: 'prod' }, poolWith(query),
    )).resolves.toEqual({ updated: true });
    expect(query.mock.calls.some(([sql]) => String(sql).includes('matriz_staff_sessions'))).toBe(true);
  });
});

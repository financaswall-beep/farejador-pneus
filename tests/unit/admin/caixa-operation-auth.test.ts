import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  authenticateOperation,
  listOperationWorkplaces,
  publicOperationWorkplace,
} from '../../../src/admin/caixa/operation-auth.js';
import { authenticatePersonCredentials } from '../../../src/parceiro/people.js';

vi.mock('../../../src/persistence/db.js', () => ({ pool: {} }));
vi.mock('../../../src/parceiro/people.js', () => ({
  authenticatePersonCredentials: vi.fn(),
}));

describe('resolução segura do local da Operação da Loja', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lista Matriz e somente parceiras com ao menos um módulo operacional', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ collaborator_id: 'collab-1' }] })
      .mockResolvedValueOnce({ rows: [
        {
          token_id: 'token-rio', slug: 'rio-do-ouro', store_name: 'Borracharia Rio do Ouro',
          role: 'funcionario', display_name: 'Wallace',
          allow_vendas: true, allow_estoque: false, allow_entregas: false,
        },
        {
          token_id: 'token-bloqueado', slug: 'loja-bloqueada', store_name: 'Loja Bloqueada',
          role: 'funcionario', display_name: 'Bloqueado',
          allow_vendas: false, allow_estoque: false, allow_entregas: false,
        },
      ] });
    const dbPool = { query } as unknown as Pool;

    const workplaces = await listOperationWorkplaces('test', 'person-1', dbPool);

    expect(workplaces.map((item) => item.id)).toEqual(['matrix', 'partner:rio-do-ouro']);
    expect(workplaces[1]).toMatchObject({
      displayName: 'Wallace',
      modules: { vendas: true, estoque: false, entregas: false },
    });
    expect(query).toHaveBeenCalledTimes(2);
    const sql = query.mock.calls.map((call) => String(call[0])).join('\n');
    expect(sql).toContain("mc.job = 'vendedor'");
    expect(sql).toContain('network.partner_token_permissions');
    expect(sql).toContain('network.partner_unit_permissions');
  });

  it('não expõe IDs internos e retorna nulo para conta sem local permitido', async () => {
    vi.mocked(authenticatePersonCredentials).mockResolvedValue({ personId: 'person-1', username: 'wallace' });
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const dbPool = { query } as unknown as Pool;

    expect(await authenticateOperation('test', 'wallace', 'senha', dbPool)).toBeNull();

    const safe = publicOperationWorkplace({
      id: 'partner:rio-do-ouro',
      kind: 'partner',
      name: 'Borracharia Rio do Ouro',
      role: 'funcionario',
      slug: 'rio-do-ouro',
      tokenId: 'secreto-no-servidor',
      displayName: 'Wallace',
      modules: { vendas: true, estoque: true, entregas: true },
    });
    expect(safe).toEqual({
      id: 'partner:rio-do-ouro',
      kind: 'partner',
      name: 'Borracharia Rio do Ouro',
      role: 'funcionario',
    });
    expect(safe).not.toHaveProperty('tokenId');
  });
});

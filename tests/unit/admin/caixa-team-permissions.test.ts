import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/persistence/db.js', () => ({ pool: {} }));
vi.mock('../../../src/shared/config/env.js', () => ({ env: { FAREJADOR_ENV: 'test' } }));

import {
  getMatrizOperationPermissions,
  saveMatrizOperationPermissions,
} from '../../../src/admin/caixa/operation-team-permissions.js';

const row = {
  id: '4f8cc2e9-0250-4f42-92ca-ce4fd9cb997a', person_id: 'person-1',
  display_name: 'Wallace', username: 'wallace', job: 'vendedor', job_title: 'Vendedor',
  panel_role: null, active: true, allow_vendas: true,
  allow_estoque: true, allow_entregas: false, allow_financeiro: false,
  allow_resumo: true, allow_bot: false, allow_retiradas: true, allow_clientes: true,
  allow_compras: true, allow_logistica: false, allow_rede: false, allow_marketing: false,
  allow_colaboradores: false, allow_catalogo: true,
};

const input = {
  resumo: true, bot: false, vendas: false, retiradas: true, clientes: true,
  compras: true, estoque: true, logistica: true, financeiro: false,
  rede: false, marketing: false, colaboradores: false, catalogo: true,
};

describe('permissÃµes da Matriz na OperaÃ§Ã£o da Loja', () => {
  it('lÃª a permissÃ£o individual e expÃµe somente mÃ³dulos existentes na Matriz', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [row] });
    const result = await getMatrizOperationPermissions(row.id, { query } as unknown as Pool);

    expect(result).toMatchObject({
      unit_name: 'Matriz', locked: false,
      permissions: { resumo: true, vendas: true, retiradas: true, compras: true, catalogo: true },
      available_permissions: expect.arrayContaining(['resumo', 'bot', 'vendas', 'compras', 'logistica', 'catalogo']),
    });
    expect(String(query.mock.calls[0]?.[0])).toContain('matriz_collaborator_operation_permissions');
  });

  it('grava, encerra sessÃµes do alvo e devolve o novo acesso', async () => {
    const clientQuery = vi.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ person_id: 'person-1', panel_role: null }] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const client = { query: clientQuery, release: vi.fn() };
    const db = {
      connect: vi.fn().mockResolvedValue(client),
      query: vi.fn().mockResolvedValue({ rows: [{ ...row, allow_vendas: false, allow_entregas: true, allow_logistica: true }] }),
    } as unknown as Pool;

    const result = await saveMatrizOperationPermissions(
      row.id, input, 'Dono', db,
    );

    expect(result.permissions).toMatchObject({ vendas: false, estoque: true, logistica: true, financeiro: false });
    expect(clientQuery.mock.calls.map((call) => String(call[0])).join('\n'))
      .toContain('UPDATE network.matriz_staff_sessions');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('protege o acesso do proprietÃ¡rio', async () => {
    const clientQuery = vi.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ person_id: 'owner-1', panel_role: 'owner' }] })
      .mockResolvedValueOnce({});
    const client = { query: clientQuery, release: vi.fn() };
    const db = { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;

    await expect(saveMatrizOperationPermissions(
      row.id, { ...input, resumo: false, estoque: false, logistica: false }, 'Dono', db,
    )).rejects.toThrow('owner_permissions_locked');
    expect(client.release).toHaveBeenCalledOnce();
  });
});

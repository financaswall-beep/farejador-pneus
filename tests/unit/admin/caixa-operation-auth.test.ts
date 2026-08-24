import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  authenticatePanelAccess,
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
      .mockResolvedValueOnce({ rows: [{ collaborator_id: 'collab-1', job: 'vendedor', work_area: 'sales', panel_role: null }] })
      .mockResolvedValueOnce({ rows: [
        {
          token_id: 'token-rio', slug: 'rio-do-ouro', store_name: 'Borracharia Rio do Ouro',
          role: 'funcionario', display_name: 'Wallace', modern_panel_enabled: true,
          allow_vendas: true, allow_estoque: false, allow_entregas: false, allow_retiradas: false,
        },
        {
          token_id: 'token-bloqueado', slug: 'loja-bloqueada', store_name: 'Loja Bloqueada',
          role: 'funcionario', display_name: 'Bloqueado',
          allow_vendas: false, allow_estoque: false, allow_entregas: false, allow_retiradas: false,
        },
      ] });
    const dbPool = { query } as unknown as Pool;

    const workplaces = await listOperationWorkplaces('test', 'person-1', dbPool);

    expect(workplaces.map((item) => item.id)).toEqual(['matrix', 'partner:rio-do-ouro']);
    expect(workplaces[1]).toMatchObject({
      displayName: 'Wallace',
      modernPanelEnabled: true,
      modules: { vendas: true, estoque: false, entregas: false, retiradas: false, financeiro: false },
    });
    expect(query).toHaveBeenCalledTimes(2);
    const sql = query.mock.calls.map((call) => String(call[0])).join('\n');
    expect(sql).toContain("mc.job = 'vendedor'");
    expect(sql).toContain("mc.job = 'entregador'");
    expect(sql).toContain('network.partner_token_permissions');
    expect(sql).toContain('network.partner_unit_permissions');
  });

  it('leva o entregador da Matriz direto ao módulo Entregas sem liberar Vendas', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows: [{ collaborator_id: 'courier-1', job: 'entregador', work_area: null, panel_role: null }],
      })
      .mockResolvedValueOnce({ rows: [] });
    const dbPool = { query } as unknown as Pool;

    const workplaces = await listOperationWorkplaces('test', 'person-courier', dbPool);

    expect(workplaces).toEqual([{
      id: 'matrix',
      kind: 'matrix',
      name: 'Matriz',
      role: 'entregador',
      collaboratorId: 'courier-1',
      modules: { vendas: false, estoque: false, entregas: true, retiradas: false, financeiro: false },
    }]);
  });

  it('libera o Financeiro somente para owner/admin da Matriz', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        collaborator_id: 'admin-1', job: 'colaborador', work_area: 'administrative', panel_role: 'admin',
      }] })
      .mockResolvedValueOnce({ rows: [] });
    const dbPool = { query } as unknown as Pool;

    const workplaces = await listOperationWorkplaces('test', 'person-admin', dbPool);

    expect(workplaces).toEqual([{
      id: 'matrix', kind: 'matrix', name: 'Matriz', role: 'admin', collaboratorId: 'admin-1',
      modules: { vendas: false, estoque: false, entregas: false, retiradas: false, financeiro: true },
    }]);
    expect(String(query.mock.calls[0]?.[0])).toContain('mc.panel_role IS NOT NULL');
  });

  it('entrega ao proprietário da Matriz todos os módulos existentes no app', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        collaborator_id: 'owner-1', job: 'colaborador', work_area: 'administrative', panel_role: 'owner',
        allow_vendas: false, allow_entregas: false, allow_financeiro: false,
      }] })
      .mockResolvedValueOnce({ rows: [] });
    const dbPool = { query } as unknown as Pool;

    const workplaces = await listOperationWorkplaces('test', 'person-owner', dbPool);

    expect(workplaces[0]).toMatchObject({
      role: 'owner',
      modules: { vendas: true, estoque: true, entregas: true, retiradas: true, financeiro: true },
    });
  });

  it('faz a permissÃ£o individual da Matriz prevalecer sobre o cargo legado', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        collaborator_id: 'collab-override', job: 'vendedor', work_area: 'sales', panel_role: null,
        allow_vendas: false, allow_estoque: false, allow_entregas: true, allow_financeiro: false,
      }] })
      .mockResolvedValueOnce({ rows: [] });
    const dbPool = { query } as unknown as Pool;

    const workplaces = await listOperationWorkplaces('test', 'person-override', dbPool);

    expect(workplaces[0]).toMatchObject({
      modules: { vendas: false, estoque: false, entregas: true, retiradas: false, financeiro: false },
    });
    expect(String(query.mock.calls[0]?.[0])).toContain('matriz_collaborator_operation_permissions');
  });

  it('permite que o dono libere o Financeiro simples para funcionÃ¡rio parceiro', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        token_id: 'finance-rio', slug: 'rio-do-ouro', store_name: 'Borracharia Rio do Ouro',
        role: 'funcionario', display_name: 'Wallace', allow_vendas: false,
        allow_estoque: false, allow_entregas: false, allow_retiradas: false, allow_financeiro: true,
      }] });
    const dbPool = { query } as unknown as Pool;

    const workplaces = await listOperationWorkplaces('test', 'person-finance', dbPool);

    expect(workplaces[0]).toMatchObject({
      role: 'funcionario', modules: {
        vendas: false, estoque: false, entregas: false, retiradas: false, financeiro: true,
      },
    });
  });

  it('mantem o proprietario parceiro no app mesmo quando so o Financeiro esta disponivel', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        token_id: 'owner-rio', slug: 'rio-do-ouro', store_name: 'Borracharia Rio do Ouro',
        role: 'owner', display_name: 'Dono', allow_vendas: false,
        allow_estoque: false, allow_entregas: false, allow_retiradas: true,
      }] });
    const dbPool = { query } as unknown as Pool;

    const workplaces = await listOperationWorkplaces('test', 'person-owner', dbPool);

    expect(workplaces[0]).toMatchObject({
      role: 'owner',
      modules: { vendas: false, estoque: false, entregas: false, retiradas: true, financeiro: true },
    });
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
      modernPanelEnabled: false,
      modules: { vendas: true, estoque: true, entregas: true, retiradas: true, financeiro: false },
    });
    expect(safe).toEqual({
      id: 'partner:rio-do-ouro',
      kind: 'partner',
      name: 'Borracharia Rio do Ouro',
      role: 'funcionario',
    });
    expect(safe).not.toHaveProperty('tokenId');
  });

  it('não oferece o painel da Matriz a vendedor/entregador sem panel_role', async () => {
    vi.mocked(authenticatePersonCredentials).mockResolvedValue({ personId: 'person-2', username: 'operador' });
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        collaborator_id: 'seller-1', job: 'vendedor', work_area: 'sales', panel_role: null,
      }] })
      .mockResolvedValueOnce({ rows: [{
        token_id: 'partner-1', slug: 'rio-do-ouro', store_name: 'Rio do Ouro',
        role: 'funcionario', display_name: 'Operador', allow_vendas: true,
        allow_estoque: false, allow_entregas: false, allow_retiradas: false, allow_financeiro: false,
      }] });
    const dbPool = { query } as unknown as Pool;

    const result = await authenticatePanelAccess('test', 'operador', 'senha', dbPool);

    expect(result?.workplaces.map((workplace) => workplace.id))
      .toEqual(['partner:rio-do-ouro']);
  });
});

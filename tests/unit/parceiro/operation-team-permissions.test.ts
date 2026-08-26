import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/persistence/db.js', () => ({ pool: {} }));
vi.mock('../../../src/parceiro/queries.js', () => ({
  getPartnerTokenPermissions: vi.fn(),
  upsertPartnerTokenPermissions: vi.fn(),
}));

import {
  getPartnerOperationPermissions,
  savePartnerOperationPermissions,
} from '../../../src/parceiro/operation-team-permissions.js';
import {
  getPartnerTokenPermissions,
  upsertPartnerTokenPermissions,
} from '../../../src/parceiro/queries.js';
import type { PartnerContext } from '../../../src/parceiro/auth.js';

const context: PartnerContext = {
  environment: 'prod', partnerId: 'partner-1', partnerUnitId: 'unit-partner-1',
  unitId: 'unit-core-1', slug: 'rio-do-ouro', partnerName: 'Rio do Ouro',
  unitName: 'Borracharia Rio do Ouro', role: 'owner', tokenId: 'owner-1',
};
const permissions = {
  vendas: true, estoque: true, pedidos: false, clientes: true, entregas: false,
  retiradas: false, batepapo: false, resumo: false, financeiro: false,
  compras: true, colaboradores: false, catalogo: true,
};

describe('permissÃµes do colaborador parceiro na OperaÃ§Ã£o da Loja', () => {
  beforeEach(() => vi.clearAllMocks());

  it('usa o perfil individual existente e mantÃ©m o escopo da unidade', async () => {
    vi.mocked(getPartnerTokenPermissions).mockResolvedValue(permissions);
    const query = vi.fn().mockResolvedValue({ rows: [{
      id: 'employee-1', name: 'Wallace', username: 'wallace', active: true, job_role: 'vendedor',
    }] });

    const result = await getPartnerOperationPermissions(context, 'employee-1', { query } as unknown as Pool);

    expect(query).toHaveBeenCalledWith(expect.stringContaining('pat.partner_unit_id=$2'), [
      'prod', 'unit-partner-1', 'employee-1',
    ]);
    expect(result).toMatchObject({ unit_name: 'Borracharia Rio do Ouro', permissions, locked: false });
    expect(result?.available_permissions).toHaveLength(12);
    expect(result?.available_permissions).toContain('batepapo');
    expect(result?.available_permissions).toContain('catalogo');
  });

  it('salva e revoga somente as sessÃµes do colaborador alterado', async () => {
    vi.mocked(upsertPartnerTokenPermissions).mockResolvedValue({ ...permissions, financeiro: true });
    const query = vi.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: 'employee-1', name: 'Wallace', username: 'wallace', active: true, job_role: 'vendedor' }] });
    const db = { query } as unknown as Pool;

    const result = await savePartnerOperationPermissions(
      context, 'employee-1', { ...permissions, financeiro: true }, db,
    );

    expect(upsertPartnerTokenPermissions).toHaveBeenCalledWith(
      context, 'employee-1', { ...permissions, financeiro: true }, db,
    );
    expect(String(query.mock.calls[0]?.[0])).toContain('UPDATE network.partner_sessions');
    expect(query.mock.calls[0]?.[1]).toEqual(['prod', 'employee-1']);
    expect(result.permissions.financeiro).toBe(true);
  });
});

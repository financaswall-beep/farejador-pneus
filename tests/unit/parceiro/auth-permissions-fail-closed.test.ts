import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../../src/persistence/db.js', () => ({ pool: { query } }));
vi.mock('../../../src/parceiro/db.js', () => ({ partnerPool: { query: vi.fn() } }));
vi.mock('../../../src/shared/config/env.js', () => ({ env: { FAREJADOR_ENV: 'test' } }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { error: vi.fn() } }));

import { resolvePartnerPermissions, type PartnerContext } from '../../../src/parceiro/auth.js';

const employee: PartnerContext = {
  environment: 'test', partnerId: 'partner-1', partnerUnitId: 'unit-1',
  unitId: 'core-1', slug: 'loja', partnerName: 'Loja', unitName: 'Loja',
  role: 'funcionario', tokenId: 'token-1',
};

describe('permissões do parceiro falham fechadas', () => {
  beforeEach(() => query.mockReset());

  it('não herda perfil da unidade nem defaults quando falta a linha individual', async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await resolvePartnerPermissions(employee)).toEqual({
      vendas: false, estoque: false, pedidos: false, clientes: false,
      entregas: false, retiradas: false, batepapo: false, resumo: false, financeiro: false,
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0]?.[0])).toContain('partner_token_permissions');
  });

  it('mantém o dono independente da tabela de permissões', async () => {
    const owner = { ...employee, role: 'owner' as const };
    expect(Object.values(await resolvePartnerPermissions(owner)).every(Boolean)).toBe(true);
    expect(query).not.toHaveBeenCalled();
  });
});

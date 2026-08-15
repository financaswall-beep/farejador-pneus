import type { Pool } from 'pg';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { PartnerContext, PartnerPermissions } from '../../../src/parceiro/auth.js';

vi.mock('../../../src/parceiro/password.js', () => ({
  hashPassword: vi.fn().mockResolvedValue('safe-hash'),
  verifyPassword: vi.fn(), fakeVerify: vi.fn(), newSessionToken: vi.fn(),
  hashSessionToken: vi.fn(),
}));

let createMatrix: typeof import('../../../src/admin/painel/queries-colaboradores.js').createMatrizCollaborator;
let createPartner: typeof import('../../../src/parceiro/queries.js').createPartnerFuncionario;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
    CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'test-token',
  });
  ({ createMatrizCollaborator: createMatrix } = await import('../../../src/admin/painel/queries-colaboradores.js'));
  ({ createPartnerFuncionario: createPartner } = await import('../../../src/parceiro/queries.js'));
});

function fakePool(query: ReturnType<typeof vi.fn>): Pool {
  return { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) } as unknown as Pool;
}

const context: PartnerContext = {
  environment: 'test', partnerId: 'partner-1', partnerUnitId: 'unit-1', unitId: 'core-1',
  slug: 'rio-do-ouro', partnerName: 'Rio do Ouro', unitName: 'Borracharia Rio do Ouro',
  role: 'owner', tokenId: 'owner-1',
};

describe('cadastro de colaborador pela Operação da Loja', () => {
  it('cria a conta da Matriz e as permissões iniciais na mesma transação', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('INSERT INTO network.partner_people')) return { rows: [{ id: 'person-1' }] };
      if (sql.includes('INSERT INTO network.matriz_collaborators')) return { rows: [{ id: 'collab-1' }] };
      return { rows: [] };
    });
    const result = await createMatrix({
      environment: 'test', display_name: 'Wallace', username: 'wallace.novo',
      password: 'senha-segura-123', job: 'vendedor', job_title: 'Vendedor',
      work_area: 'sales', panel_role: null, actor_label: 'Proprietário',
      operation_permissions: { vendas: true, entregas: false, financeiro: false },
    }, fakePool(query));

    expect(result).toEqual({ id: 'collab-1', username: 'wallace.novo' });
    const statements = query.mock.calls.map((call) => String(call[0]));
    expect(statements).toContain('BEGIN');
    expect(statements.some((sql) => sql.includes('matriz_collaborator_operation_permissions'))).toBe(true);
    expect(statements.at(-1)).toBe('COMMIT');
  });

  it('cria a conta parceira e seu acesso mínimo de forma atômica', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('INSERT INTO network.partner_people')) return { rows: [{ id: 'person-2' }] };
      if (sql.includes('INSERT INTO network.partner_access_tokens')) {
        return { rows: [{ id: 'token-2', created_at: '2026-08-14T12:00:00Z' }] };
      }
      return { rows: [] };
    });
    const permissions: PartnerPermissions = {
      vendas: false, estoque: true, pedidos: false, clientes: false,
      entregas: false, retiradas: false, batepapo: false, resumo: false, financeiro: false,
    };
    const result = await createPartner(
      context, 'João', 'joao.estoque', 'senha-segura-123', permissions, fakePool(query),
    );

    expect(result).toMatchObject({ id: 'token-2', username: 'joao.estoque' });
    const statements = query.mock.calls.map((call) => String(call[0]));
    expect(statements.some((sql) => sql.includes('partner_token_permissions'))).toBe(true);
    expect(statements.at(-1)).toBe('COMMIT');
  });
});

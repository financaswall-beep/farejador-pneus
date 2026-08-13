import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { PartnerContext } from '../../../src/parceiro/auth.js';

let reactivate: typeof import('../../../src/parceiro/queries.js').reactivatePartnerFuncionario;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
    CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'test-token',
  });
  ({ reactivatePartnerFuncionario: reactivate } = await import('../../../src/parceiro/queries.js'));
});

const ctx: PartnerContext = {
  environment: 'test', partnerId: 'p1', partnerUnitId: 'pu1', unitId: 'u1',
  slug: 'loja-a', partnerName: 'Loja A', unitName: 'Unidade A', role: 'owner', tokenId: 'owner1',
};

function poolWith(query: ReturnType<typeof vi.fn>): Pool {
  return { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) } as unknown as Pool;
}

describe('ciclo de vida de funcionários parceiros', () => {
  it('reativa somente o vínculo revogado da unidade autenticada', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ person_id: 'person1' }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({});

    await expect(reactivate(ctx, 'token1', poolWith(query))).resolves.toEqual({ reactivated: true });
    expect(query.mock.calls[1][1]).toEqual(['token1', 'test', 'pu1']);
    expect(String(query.mock.calls[3][0])).toContain("role = 'funcionario'");
  });

  it('mantém ativos na lista principal e desativados em uma área separada', () => {
    const app = readFileSync(path.join(process.cwd(), 'parceiro/public/app.config.js'), 'utf8');
    const html = readFileSync(path.join(process.cwd(), 'parceiro/public/index.html'), 'utf8');
    expect(app).toContain('get funcionariosAtivos()');
    expect(app).toContain('get funcionariosDesativados()');
    expect(html).toContain("funcionarioView === 'ativos' ? funcionariosAtivos : funcionariosDesativados");
    expect(html).toContain('Reativar funcionário');
  });
});

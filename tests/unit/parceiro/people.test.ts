import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticatePersonGlobal } from '../../../src/parceiro/people.js';
import { pool } from '../../../src/persistence/db.js';
import { fakeVerify, verifyPassword } from '../../../src/parceiro/password.js';

vi.mock('../../../src/persistence/db.js', () => ({ pool: { query: vi.fn() } }));
vi.mock('../../../src/parceiro/password.js', () => ({
  fakeVerify: vi.fn(),
  verifyPassword: vi.fn(),
}));

describe('identidade global compartilhada', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mantém o login antigo do parceiro após separar identidade e vínculos', async () => {
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [{ id: 'person-1', username: 'wallace', password_hash: 'hash' }] } as never)
      .mockResolvedValueOnce({ rows: [{
        token_id: 'token-1', slug: 'rio-do-ouro', store_name: 'Borracharia Rio do Ouro', role: 'funcionario',
      }] } as never);
    vi.mocked(verifyPassword).mockResolvedValue(true);

    const result = await authenticatePersonGlobal('test', 'wallace', 'senha-correta');

    expect(result).toEqual({
      personId: 'person-1',
      stores: [{
        token_id: 'token-1', slug: 'rio-do-ouro', store_name: 'Borracharia Rio do Ouro', role: 'funcionario',
      }],
    });
    expect(verifyPassword).toHaveBeenCalledWith('senha-correta', 'hash');
  });

  it('mantém a proteção de tempo para usuário inexistente', async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [] } as never);
    expect(await authenticatePersonGlobal('test', 'inexistente', 'senha')).toBeNull();
    expect(fakeVerify).toHaveBeenCalledWith('senha');
  });
});

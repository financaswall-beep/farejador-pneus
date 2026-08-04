import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { changeCaixaPassword } from '../../../src/admin/caixa/queries.js';
import { hashPassword, verifyPassword } from '../../../src/parceiro/password.js';

vi.mock('../../../src/persistence/db.js', () => ({ pool: {} }));
vi.mock('../../../src/parceiro/password.js', () => ({
  fakeVerify: vi.fn(),
  hashPassword: vi.fn(),
  hashSessionToken: vi.fn((value: string) => `hash:${value}`),
  verifyPassword: vi.fn(),
}));

describe('troca de senha do operador de caixa', () => {
  beforeEach(() => vi.clearAllMocks());

  it('atualiza a pessoa e revoga todas as sessões após validar a senha atual', async () => {
    vi.mocked(verifyPassword).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    vi.mocked(hashPassword).mockResolvedValue('novo-hash');
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT password_hash')) return { rows: [{ password_hash: 'hash-atual' }] };
      return { rows: [], rowCount: 1 };
    });
    const release = vi.fn();
    const dbPool = { connect: vi.fn(async () => ({ query, release })) } as unknown as Pool;

    const result = await changeCaixaPassword('prod', 'person-1', 'senha-atual', 'senha-nova-segura', dbPool);

    expect(result).toBe('changed');
    expect(verifyPassword).toHaveBeenNthCalledWith(1, 'senha-atual', 'hash-atual');
    expect(verifyPassword).toHaveBeenNthCalledWith(2, 'senha-nova-segura', 'hash-atual');
    expect(hashPassword).toHaveBeenCalledWith('senha-nova-segura');
    const sql = query.mock.calls.map((call) => String(call[0])).join('\n');
    expect(sql).toContain('UPDATE network.partner_people');
    expect(sql).toContain('UPDATE network.partner_access_tokens');
    expect(sql).toContain('UPDATE network.matriz_staff_sessions');
    expect(sql).toContain('COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });

  it('recusa a senha atual incorreta sem gravar nenhuma alteração', async () => {
    vi.mocked(verifyPassword).mockResolvedValueOnce(false);
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT password_hash')) return { rows: [{ password_hash: 'hash-atual' }] };
      return { rows: [], rowCount: null };
    });
    const release = vi.fn();
    const dbPool = { connect: vi.fn(async () => ({ query, release })) } as unknown as Pool;

    const result = await changeCaixaPassword('prod', 'person-1', 'errada', 'senha-nova-segura', dbPool);

    expect(result).toBe('invalid_current_password');
    const sql = query.mock.calls.map((call) => String(call[0])).join('\n');
    expect(sql).not.toContain('UPDATE network.partner_people');
    expect(sql).toContain('ROLLBACK');
    expect(release).toHaveBeenCalledOnce();
  });
});

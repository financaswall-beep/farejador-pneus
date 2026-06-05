/**
 * Testes de integração do LOGIN do Portal Parceiro — P1 (usuário+senha + sessões).
 *
 * Cobertura:
 *   1. Funcionário criado pelo dono loga com usuário+senha → emite sessão (ps_…)
 *      → a sessão valida e devolve o papel/unidade certos.
 *   2. Senha errada → login null. Usuário inexistente → login null.
 *   3. Primeiro acesso do dono (set-credentials por token cru) → login do dono.
 *   4. Revogar o funcionário mata a sessão dele na hora.
 *   5. Sessão expirada não valida.
 *   6. Usuário é único por unidade (mesma unidade duplica → conflito; outra
 *      unidade pode repetir).
 *   7. Isolamento: credenciais da unidade A não logam na unidade B.
 *   8. set-credentials por sessão num login que já tem senha → erro (use reset).
 *   9. Logout revoga a sessão no servidor.
 *
 * Banco efêmero (testcontainers) — morre no afterAll. Não toca bot/atendente.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres';
import { createPartnerFixture } from './helpers/partner-fixtures';

let db: IntegrationDb;

beforeAll(async () => {
  db = await startPostgres();
  process.env.DATABASE_URL = db.connectionString;
  process.env.FAREJADOR_ENV = 'test';
  process.env.NODE_ENV = 'test';
  process.env.CHATWOOT_HMAC_SECRET = 'test-secret-not-used-here';
  process.env.ADMIN_AUTH_TOKEN = 'admin-not-used-here-1234567890';
}, 180_000);

afterAll(async () => {
  if (db) await stopPostgres(db);
});

async function importQueries() {
  return import('../../src/parceiro/queries.js');
}
async function importAuth() {
  return import('../../src/parceiro/auth.js');
}
async function importPassword() {
  return import('../../src/parceiro/password.js');
}

// ── 1. Funcionário: criar → logar → sessão valida ───────────────────────────
describe('Login — funcionário criado pelo dono', () => {
  it('loga com usuário+senha e a sessão valida com papel funcionario', async () => {
    const q = await importQueries();
    const auth = await importAuth();
    const f = await createPartnerFixture(db.pool);

    const created = await q.createPartnerFuncionario(f.ctx, 'João Balcão', 'joao', 'senha123');
    expect(created.username).toBe('joao');

    const login = await q.authenticatePartnerLogin('test', f.slug, 'joao', 'senha123');
    expect(login).not.toBeNull();
    expect(login!.session_token.startsWith('ps_')).toBe(true);

    const ctx = await auth.authenticatePartnerSession(f.slug, login!.session_token);
    expect(ctx).not.toBeNull();
    expect(ctx!.role).toBe('funcionario');
    expect(ctx!.unitId).toBe(f.unitId);
    expect(ctx!.tokenId).toBe(created.id);
  });

  it('é case-insensitive no usuário', async () => {
    const q = await importQueries();
    const f = await createPartnerFixture(db.pool);
    await q.createPartnerFuncionario(f.ctx, null, 'Maria', 'senha123');
    const login = await q.authenticatePartnerLogin('test', f.slug, 'maria', 'senha123');
    expect(login).not.toBeNull();
  });
});

// ── 2. Credenciais erradas ──────────────────────────────────────────────────
describe('Login — credenciais inválidas', () => {
  it('senha errada → null', async () => {
    const q = await importQueries();
    const f = await createPartnerFixture(db.pool);
    await q.createPartnerFuncionario(f.ctx, null, 'pedro', 'certa123');
    expect(await q.authenticatePartnerLogin('test', f.slug, 'pedro', 'errada')).toBeNull();
  });

  it('usuário inexistente → null', async () => {
    const q = await importQueries();
    const f = await createPartnerFixture(db.pool);
    expect(await q.authenticatePartnerLogin('test', f.slug, 'ninguem', 'x123456')).toBeNull();
  });
});

// ── 3. Primeiro acesso do dono ──────────────────────────────────────────────
describe('Login — primeiro acesso do dono', () => {
  it('set-credentials por token cru define usuário+senha e já devolve sessão', async () => {
    const q = await importQueries();
    const auth = await importAuth();
    const f = await createPartnerFixture(db.pool); // dono, token cru, sem senha

    const result = await q.setOwnPartnerCredentials(f.ctx, 'dono', 'donosenha', true);
    expect(result.session_token.startsWith('ps_')).toBe(true);

    // A sessão devolvida já vale e é do dono.
    const ctx0 = await auth.authenticatePartnerSession(f.slug, result.session_token);
    expect(ctx0!.role).toBe('owner');

    // E o dono passa a logar por usuário+senha.
    const login = await q.authenticatePartnerLogin('test', f.slug, 'dono', 'donosenha');
    expect(login).not.toBeNull();
    const ctx = await auth.authenticatePartnerSession(f.slug, login!.session_token);
    expect(ctx!.role).toBe('owner');
  });
});

// ── 4. Revogar funcionário mata a sessão ────────────────────────────────────
describe('Login — revogar funcionário', () => {
  it('sessão para de validar assim que o login é revogado', async () => {
    const q = await importQueries();
    const auth = await importAuth();
    const f = await createPartnerFixture(db.pool);
    const created = await q.createPartnerFuncionario(f.ctx, null, 'temp', 'senha123');
    const login = await q.authenticatePartnerLogin('test', f.slug, 'temp', 'senha123');
    expect(await auth.authenticatePartnerSession(f.slug, login!.session_token)).not.toBeNull();

    await q.revokePartnerFuncionario(f.ctx, created.id);

    expect(await auth.authenticatePartnerSession(f.slug, login!.session_token)).toBeNull();
    // E não loga mais.
    expect(await q.authenticatePartnerLogin('test', f.slug, 'temp', 'senha123')).toBeNull();
  });
});

// ── 5. Sessão expirada ──────────────────────────────────────────────────────
describe('Login — sessão expirada', () => {
  it('não valida depois de expires_at', async () => {
    const q = await importQueries();
    const auth = await importAuth();
    const pw = await importPassword();
    const f = await createPartnerFixture(db.pool);
    await q.createPartnerFuncionario(f.ctx, null, 'expira', 'senha123');
    const login = await q.authenticatePartnerLogin('test', f.slug, 'expira', 'senha123');

    await db.pool.query(
      `UPDATE network.partner_sessions SET expires_at = now() - interval '1 day' WHERE session_hash = $1`,
      [pw.hashSessionToken(login!.session_token)],
    );

    expect(await auth.authenticatePartnerSession(f.slug, login!.session_token)).toBeNull();
  });
});

// ── 6. Usuário único por unidade ────────────────────────────────────────────
describe('Login — unicidade do usuário', () => {
  it('mesma unidade não aceita usuário duplicado', async () => {
    const q = await importQueries();
    const f = await createPartnerFixture(db.pool);
    await q.createPartnerFuncionario(f.ctx, null, 'dup', 'senha123');
    await expect(q.createPartnerFuncionario(f.ctx, null, 'dup', 'outra123'))
      .rejects.toBeInstanceOf(q.PartnerUsernameConflictError);
  });

  it('unidades diferentes podem ter o mesmo usuário', async () => {
    const q = await importQueries();
    const a = await createPartnerFixture(db.pool);
    const b = await createPartnerFixture(db.pool);
    await q.createPartnerFuncionario(a.ctx, null, 'joao', 'senha123');
    await expect(q.createPartnerFuncionario(b.ctx, null, 'joao', 'senha123')).resolves.toBeTruthy();
  });
});

// ── 7. Isolamento entre unidades ────────────────────────────────────────────
describe('Login — isolamento entre unidades', () => {
  it('credencial da unidade A não loga na unidade B', async () => {
    const q = await importQueries();
    const a = await createPartnerFixture(db.pool);
    const b = await createPartnerFixture(db.pool);
    await q.createPartnerFuncionario(a.ctx, null, 'soa', 'senha123');
    // mesmo usuário+senha, mas no slug da unidade B → não loga
    expect(await q.authenticatePartnerLogin('test', b.slug, 'soa', 'senha123')).toBeNull();
  });
});

// ── 8. set-credentials por sessão num login que já tem senha → erro ─────────
describe('Login — set-credentials sem overwrite', () => {
  it('login que já tem senha rejeita set-credentials por sessão (allowOverwrite=false)', async () => {
    const q = await importQueries();
    const f = await createPartnerFixture(db.pool);
    await q.setOwnPartnerCredentials(f.ctx, 'dono2', 'senha123', true); // 1º acesso
    await expect(q.setOwnPartnerCredentials(f.ctx, 'dono2b', 'senha456', false))
      .rejects.toBeInstanceOf(q.PartnerCredentialsAlreadySetError);
  });
});

// ── 9. Logout revoga a sessão ───────────────────────────────────────────────
describe('Login — logout', () => {
  it('revokePartnerSession invalida a sessão atual', async () => {
    const q = await importQueries();
    const auth = await importAuth();
    const f = await createPartnerFixture(db.pool);
    await q.createPartnerFuncionario(f.ctx, null, 'sai', 'senha123');
    const login = await q.authenticatePartnerLogin('test', f.slug, 'sai', 'senha123');
    expect(await auth.authenticatePartnerSession(f.slug, login!.session_token)).not.toBeNull();

    await q.revokePartnerSession('test', login!.session_token);
    expect(await auth.authenticatePartnerSession(f.slug, login!.session_token)).toBeNull();
  });
});

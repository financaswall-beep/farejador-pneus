import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { fakeVerify, hashPassword, hashSessionToken, verifyPassword } from '../../parceiro/password.js';

const CAIXA_SESSION_PREFIX = 'cs_';
const CAIXA_SESSION_TTL_HOURS = 12;

export interface CaixaModules {
  vendas: boolean;
  estoque: boolean;
  entregas: boolean;
}

export interface CaixaAuth {
  personId: string;
  collaboratorId: string;
  displayName: string;
  username: string;
  job: 'vendedor' | 'entregador';
  modules: CaixaModules;
}

export interface CaixaLoginResult {
  session_token: string;
  expires_at: string;
  display_name: string;
  username: string;
}

function newCaixaSessionToken(): { token: string; hash: string } {
  const token = CAIXA_SESSION_PREFIX + randomBytes(32).toString('hex');
  return { token, hash: hashSessionToken(token) };
}

function modulesForJob(job: 'vendedor' | 'entregador'): CaixaModules {
  return {
    vendas: job === 'vendedor',
    estoque: false,
    entregas: job === 'entregador',
  };
}

export function isCaixaSessionToken(value: string): boolean {
  return /^cs_[a-f0-9]{64}$/.test(value);
}

/**
 * Emite a sessão da Matriz depois que a identidade global já foi conferida.
 * Revalida o vínculo no mesmo instante da emissão para uma revogação concorrente
 * nunca transformar um ticket ainda vivo em acesso válido.
 */
export async function mintCaixaSessionForPerson(
  environment: 'prod' | 'test',
  personId: string,
  collaboratorId: string,
  dbPool: Pool = defaultPool,
): Promise<CaixaLoginResult | null> {
  const result = await dbPool.query<{
    display_name: string;
    username: string;
    job: 'vendedor' | 'entregador';
  }>(
    `SELECT mc.display_name, pp.username, mc.job
       FROM network.matriz_collaborators mc
       JOIN network.partner_people pp
         ON pp.id = mc.person_id AND pp.environment = mc.environment
      WHERE mc.environment = $1
        AND mc.person_id = $2
        AND mc.id = $3
        AND mc.revoked_at IS NULL
        AND ((mc.job = 'vendedor' AND mc.work_area = 'sales')
          OR mc.job = 'entregador')
        AND pp.revoked_at IS NULL
      LIMIT 1`,
    [environment, personId, collaboratorId],
  );
  const row = result.rows[0];
  if (!row) return null;

  const { token, hash } = newCaixaSessionToken();
  const expiresAt = new Date(Date.now() + CAIXA_SESSION_TTL_HOURS * 60 * 60 * 1000).toISOString();
  await dbPool.query(
    `INSERT INTO network.matriz_staff_sessions
       (environment, person_id, session_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [environment, personId, hash, expiresAt],
  );
  return {
    session_token: token,
    expires_at: expiresAt,
    display_name: row.display_name,
    username: row.username,
  };
}

/**
 * Autentica somente vendedor ativo da Matriz. A consulta resolve pessoa e
 * colaborador antes da decisão e mantém a mesma resposta para todos os erros.
 */
export async function authenticateCaixa(
  environment: 'prod' | 'test',
  username: string,
  password: string,
  dbPool: Pool = defaultPool,
): Promise<CaixaLoginResult | null> {
  const result = await dbPool.query<{
    person_id: string;
    password_hash: string | null;
    collaborator_id: string | null;
    display_name: string | null;
    username: string;
    job: string | null;
    work_area: string | null;
  }>(
    `SELECT pp.id AS person_id, pp.password_hash, pp.username,
            mc.id AS collaborator_id, mc.display_name, mc.job, mc.work_area
       FROM network.partner_people pp
       LEFT JOIN network.matriz_collaborators mc
         ON mc.person_id = pp.id AND mc.environment = pp.environment
        AND mc.revoked_at IS NULL
      WHERE pp.environment = $1 AND lower(pp.username) = lower($2)
        AND pp.revoked_at IS NULL AND pp.password_hash IS NOT NULL
      LIMIT 1`,
    [environment, username.trim()],
  );

  const row = result.rows[0];
  if (!row) {
    await fakeVerify(password);
    return null;
  }
  if (!(await verifyPassword(password, row.password_hash))) return null;
  if (!row.collaborator_id || !row.display_name
      || row.job !== 'vendedor' || row.work_area !== 'sales') return null;

  const { token, hash } = newCaixaSessionToken();
  const expiresAt = new Date(Date.now() + CAIXA_SESSION_TTL_HOURS * 60 * 60 * 1000).toISOString();
  await dbPool.query(
    `INSERT INTO network.matriz_staff_sessions
       (environment, person_id, session_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [environment, row.person_id, hash, expiresAt],
  );

  return {
    session_token: token,
    expires_at: expiresAt,
    display_name: row.display_name,
    username: row.username,
  };
}

/** Revogar o vendedor ou mudar sua função invalida a sessão imediatamente. */
export async function validateCaixaSession(
  environment: 'prod' | 'test',
  sessionToken: string,
  dbPool: Pool = defaultPool,
): Promise<CaixaAuth | null> {
  if (!isCaixaSessionToken(sessionToken)) return null;
  const result = await dbPool.query<{
    person_id: string;
    collaborator_id: string;
    display_name: string;
    username: string;
    job: 'vendedor' | 'entregador';
  }>(
    `UPDATE network.matriz_staff_sessions s
        SET last_used_at = now()
       FROM network.matriz_collaborators mc
       JOIN network.partner_people pp
         ON pp.id = mc.person_id AND pp.environment = mc.environment
      WHERE s.session_hash = $1 AND s.environment = $2
        AND s.revoked_at IS NULL AND s.expires_at > now()
        AND mc.person_id = s.person_id AND mc.environment = s.environment
        AND mc.revoked_at IS NULL
        AND ((mc.job = 'vendedor' AND mc.work_area = 'sales')
          OR mc.job = 'entregador')
        AND pp.revoked_at IS NULL
      RETURNING s.person_id, mc.id AS collaborator_id, mc.display_name, pp.username, mc.job`,
    [hashSessionToken(sessionToken), environment],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    personId: row.person_id,
    collaboratorId: row.collaborator_id,
    displayName: row.display_name,
    username: row.username,
    job: row.job,
    modules: modulesForJob(row.job),
  };
}

export async function revokeCaixaSession(
  environment: 'prod' | 'test',
  sessionToken: string,
  dbPool: Pool = defaultPool,
): Promise<void> {
  if (!isCaixaSessionToken(sessionToken)) return;
  await dbPool.query(
    `UPDATE network.matriz_staff_sessions
        SET revoked_at = now()
      WHERE environment = $1 AND session_hash = $2 AND revoked_at IS NULL`,
    [environment, hashSessionToken(sessionToken)],
  );
}

export type ChangeCaixaPasswordResult =
  | 'changed'
  | 'invalid_current_password'
  | 'same_password'
  | 'account_not_found';

/**
 * Troca a senha da pessoa autenticada e encerra todas as sessões de colaborador.
 * O próximo acesso já usa exclusivamente o novo segredo.
 */
export async function changeCaixaPassword(
  environment: 'prod' | 'test',
  personId: string,
  currentPassword: string,
  newPassword: string,
  dbPool: Pool = defaultPool,
): Promise<ChangeCaixaPasswordResult> {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const person = await client.query<{ password_hash: string | null }>(
      `SELECT password_hash
         FROM network.partner_people
        WHERE id=$2 AND environment=$1 AND revoked_at IS NULL
        FOR UPDATE`,
      [environment, personId],
    );
    const storedHash = person.rows[0]?.password_hash;
    if (!storedHash) {
      await client.query('ROLLBACK');
      return 'account_not_found';
    }
    if (!await verifyPassword(currentPassword, storedHash)) {
      await client.query('ROLLBACK');
      return 'invalid_current_password';
    }
    if (await verifyPassword(newPassword, storedHash)) {
      await client.query('ROLLBACK');
      return 'same_password';
    }

    const passwordHash = await hashPassword(newPassword);
    await client.query(
      `UPDATE network.partner_people
          SET password_hash=$3,password_set_at=now()
        WHERE id=$2 AND environment=$1 AND revoked_at IS NULL`,
      [environment, personId, passwordHash],
    );
    // A senha pertence à pessoa: mantém eventuais vínculos de loja coerentes.
    await client.query(
      `UPDATE network.partner_access_tokens
          SET login_password_hash=$3,login_password_set_at=now()
        WHERE person_id=$2 AND environment=$1 AND revoked_at IS NULL`,
      [environment, personId, passwordHash],
    );
    await client.query(
      `UPDATE network.matriz_staff_sessions
          SET revoked_at=now()
        WHERE person_id=$2 AND environment=$1 AND revoked_at IS NULL`,
      [environment, personId],
    );
    await client.query('COMMIT');
    return 'changed';
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

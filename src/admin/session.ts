import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../persistence/db.js';
import { env } from '../shared/config/env.js';
import { fakeVerify, hashPassword, hashSessionToken, verifyPassword } from '../parceiro/password.js';

export const ADMIN_SESSION_COOKIE = 'farejador_matriz_session';
export const ADMIN_SESSION_TTL_SECONDS = 12 * 60 * 60;
const ADMIN_SESSION_PREFIX = 'ms_';

export type MatrizAdminRole = 'owner' | 'admin';

export interface MatrizAdminContext {
  authType: 'session' | 'emergency';
  personId: string | null;
  collaboratorId: string | null;
  displayName: string;
  username: string | null;
  role: MatrizAdminRole;
}

export interface MatrizAdminLoginResult {
  sessionToken: string;
  expiresAt: string;
  context: MatrizAdminContext;
}

export class MatrizOwnerAlreadyConfiguredError extends Error {
  constructor() { super('owner_already_configured'); }
}

export class MatrizAdminUsernameTakenError extends Error {
  constructor() { super('username_taken'); }
}

function newAdminSessionToken(): { token: string; hash: string } {
  const token = ADMIN_SESSION_PREFIX + randomBytes(32).toString('hex');
  return { token, hash: hashSessionToken(token) };
}

export function isMatrizAdminSessionToken(value: string): boolean {
  return /^ms_[a-f0-9]{64}$/.test(value);
}

async function insertSession(
  db: Pick<Pool, 'query'> | Pick<PoolClient, 'query'>,
  environment: 'prod' | 'test',
  personId: string,
): Promise<{ sessionToken: string; expiresAt: string }> {
  const { token, hash } = newAdminSessionToken();
  const expiresAt = new Date(Date.now() + ADMIN_SESSION_TTL_SECONDS * 1000).toISOString();
  await db.query(
    `INSERT INTO network.matriz_staff_sessions (environment, person_id, session_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [environment, personId, hash, expiresAt],
  );
  return { sessionToken: token, expiresAt };
}

export async function authenticateMatrizAdmin(
  environment: 'prod' | 'test',
  username: string,
  password: string,
  dbPool: Pool = defaultPool,
): Promise<MatrizAdminLoginResult | null> {
  const result = await dbPool.query<{
    person_id: string;
    password_hash: string | null;
    collaborator_id: string | null;
    display_name: string | null;
    username: string;
    panel_role: MatrizAdminRole | null;
  }>(
    `SELECT pp.id AS person_id, pp.password_hash, pp.username,
            mc.id AS collaborator_id, mc.display_name, mc.panel_role
       FROM network.partner_people pp
       LEFT JOIN network.matriz_collaborators mc
         ON mc.person_id = pp.id AND mc.environment = pp.environment
        AND mc.revoked_at IS NULL AND mc.panel_role IS NOT NULL
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
  if (!row.collaborator_id || !row.panel_role || !row.display_name) return null;

  const session = await insertSession(dbPool, environment, row.person_id);
  return {
    ...session,
    context: {
      authType: 'session',
      personId: row.person_id,
      collaboratorId: row.collaborator_id,
      displayName: row.display_name,
      username: row.username,
      role: row.panel_role,
    },
  };
}

export async function validateMatrizAdminSession(
  environment: 'prod' | 'test',
  sessionToken: string,
  dbPool: Pool = defaultPool,
): Promise<MatrizAdminContext | null> {
  if (!isMatrizAdminSessionToken(sessionToken)) return null;
  const result = await dbPool.query<{
    person_id: string;
    collaborator_id: string;
    display_name: string;
    username: string;
    panel_role: MatrizAdminRole;
  }>(
    `UPDATE network.matriz_staff_sessions s
        SET last_used_at = now()
       FROM network.matriz_collaborators mc
       JOIN network.partner_people pp ON pp.id = mc.person_id AND pp.environment = mc.environment
      WHERE s.session_hash = $1 AND s.environment = $2
        AND s.revoked_at IS NULL AND s.expires_at > now()
        AND mc.person_id = s.person_id AND mc.environment = s.environment
        AND mc.revoked_at IS NULL AND mc.panel_role IS NOT NULL
        AND pp.revoked_at IS NULL
      RETURNING s.person_id, mc.id AS collaborator_id, mc.display_name,
                pp.username, mc.panel_role`,
    [hashSessionToken(sessionToken), environment],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    authType: 'session',
    personId: row.person_id,
    collaboratorId: row.collaborator_id,
    displayName: row.display_name,
    username: row.username,
    role: row.panel_role,
  };
}

export async function revokeMatrizAdminSession(
  environment: 'prod' | 'test',
  sessionToken: string,
  dbPool: Pool = defaultPool,
): Promise<void> {
  if (!isMatrizAdminSessionToken(sessionToken)) return;
  await dbPool.query(
    `UPDATE network.matriz_staff_sessions SET revoked_at = now()
      WHERE environment = $1 AND session_hash = $2 AND revoked_at IS NULL`,
    [environment, hashSessionToken(sessionToken)],
  );
}

export async function hasMatrizOwner(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<boolean> {
  const result = await dbPool.query(
    `SELECT 1 FROM network.matriz_collaborators
      WHERE environment = $1 AND panel_role = 'owner' AND revoked_at IS NULL
      LIMIT 1`,
    [environment],
  );
  return result.rows.length > 0;
}

export async function bootstrapMatrizOwner(
  input: { displayName: string; username: string; password: string; environment?: 'prod' | 'test' },
  dbPool: Pool = defaultPool,
): Promise<MatrizAdminLoginResult> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const passwordHash = await hashPassword(input.password);
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('farejador_matriz_owner_bootstrap'))`);
    const owner = await client.query(
      `SELECT 1 FROM network.matriz_collaborators
        WHERE environment = $1 AND panel_role = 'owner' AND revoked_at IS NULL
        LIMIT 1`,
      [environment],
    );
    if (owner.rows.length > 0) throw new MatrizOwnerAlreadyConfiguredError();

    const person = await client.query<{ id: string; username: string }>(
      `INSERT INTO network.partner_people (environment, username, password_hash, password_set_at)
       VALUES ($1, $2, $3, now()) RETURNING id, username`,
      [environment, input.username.trim(), passwordHash],
    );
    const collaborator = await client.query<{ id: string }>(
      `INSERT INTO network.matriz_collaborators
         (environment, person_id, display_name, job, job_title, work_area, panel_role, created_by)
       VALUES ($1, $2, $3, 'colaborador', 'Proprietário', 'administrative', 'owner', 'bootstrap-admin-login')
       RETURNING id`,
      [environment, person.rows[0]!.id, input.displayName.trim()],
    );
    const session = await insertSession(client, environment, person.rows[0]!.id);
    await client.query('COMMIT');
    return {
      ...session,
      context: {
        authType: 'session',
        personId: person.rows[0]!.id,
        collaboratorId: collaborator.rows[0]!.id,
        displayName: input.displayName.trim(),
        username: person.rows[0]!.username,
        role: 'owner',
      },
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if ((error as { code?: string })?.code === '23505') throw new MatrizAdminUsernameTakenError();
    throw error;
  } finally {
    client.release();
  }
}

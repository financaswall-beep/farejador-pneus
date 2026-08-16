import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { fakeVerify, hashSessionToken, verifyPassword } from '../../parceiro/password.js';

export { changeCaixaPassword, type ChangeCaixaPasswordResult } from './operation-account.js';

const CAIXA_SESSION_PREFIX = 'cs_';
const CAIXA_SESSION_TTL_HOURS = 12;

export interface CaixaModules {
  vendas: boolean;
  estoque: boolean;
  entregas: boolean;
  financeiro: boolean;
}

export interface CaixaAuth {
  personId: string;
  collaboratorId: string;
  displayName: string;
  username: string;
  job: 'vendedor' | 'entregador' | 'colaborador';
  panelRole: 'owner' | 'admin' | null;
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

function modulesForAccess(
  job: 'vendedor' | 'entregador' | 'colaborador',
  workArea: string | null,
  panelRole: 'owner' | 'admin' | null,
  overrides?: { vendas: boolean | null; estoque: boolean | null; entregas: boolean | null; financeiro: boolean | null },
): CaixaModules {
  const legacy = {
    vendas: job === 'vendedor' && workArea === 'sales',
    estoque: job === 'vendedor' && workArea === 'sales',
    entregas: job === 'entregador',
    financeiro: panelRole !== null,
  };
  if (panelRole === 'owner') return { vendas: true, estoque: true, entregas: true, financeiro: true };
  return {
    vendas: overrides?.vendas ?? legacy.vendas,
    estoque: overrides?.estoque ?? legacy.estoque,
    entregas: overrides?.entregas ?? legacy.entregas,
    financeiro: overrides?.financeiro ?? legacy.financeiro,
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
    job: 'vendedor' | 'entregador' | 'colaborador';
    work_area: string | null;
    panel_role: 'owner' | 'admin' | null;
    allow_vendas: boolean | null;
    allow_estoque: boolean | null;
    allow_entregas: boolean | null;
    allow_financeiro: boolean | null;
  }>(
    `SELECT mc.display_name, pp.username, mc.job, mc.work_area, mc.panel_role,
            op.allow_vendas,op.allow_estoque,op.allow_entregas,op.allow_financeiro
       FROM network.matriz_collaborators mc
       JOIN network.partner_people pp
         ON pp.id = mc.person_id AND pp.environment = mc.environment
       LEFT JOIN network.matriz_collaborator_operation_permissions op
         ON op.collaborator_id=mc.id AND op.environment=mc.environment
      WHERE mc.environment = $1
        AND mc.person_id = $2
        AND mc.id = $3
        AND mc.revoked_at IS NULL
        AND (mc.panel_role IS NOT NULL
          OR (mc.job = 'vendedor' AND mc.work_area = 'sales')
          OR mc.job = 'entregador'
          OR COALESCE(op.allow_vendas,false)
          OR COALESCE(op.allow_estoque,false)
          OR COALESCE(op.allow_entregas,false)
          OR COALESCE(op.allow_financeiro,false))
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
    job: 'vendedor' | 'entregador' | 'colaborador';
    work_area: string | null;
    panel_role: 'owner' | 'admin' | null;
    allow_vendas: boolean | null;
    allow_estoque: boolean | null;
    allow_entregas: boolean | null;
    allow_financeiro: boolean | null;
  }>(
    `UPDATE network.matriz_staff_sessions s
        SET last_used_at = now()
       FROM network.matriz_collaborators mc
       JOIN network.partner_people pp
         ON pp.id = mc.person_id AND pp.environment = mc.environment
       LEFT JOIN network.matriz_collaborator_operation_permissions op
         ON op.collaborator_id=mc.id AND op.environment=mc.environment
      WHERE s.session_hash = $1 AND s.environment = $2
        AND s.revoked_at IS NULL AND s.expires_at > now()
        AND mc.person_id = s.person_id AND mc.environment = s.environment
        AND mc.revoked_at IS NULL
        AND (mc.panel_role IS NOT NULL
          OR (mc.job = 'vendedor' AND mc.work_area = 'sales')
          OR mc.job = 'entregador'
          OR COALESCE(op.allow_vendas,false)
          OR COALESCE(op.allow_estoque,false)
          OR COALESCE(op.allow_entregas,false)
          OR COALESCE(op.allow_financeiro,false))
        AND pp.revoked_at IS NULL
      RETURNING s.person_id, mc.id AS collaborator_id, mc.display_name, pp.username,
                mc.job, mc.work_area, mc.panel_role,
                op.allow_vendas,op.allow_estoque,op.allow_entregas,op.allow_financeiro`,
    [hashSessionToken(sessionToken), environment],
  );
  const row = result.rows[0];
  if (!row) return null;
  const panelRole = row.panel_role ?? null;
  return {
    personId: row.person_id,
    collaboratorId: row.collaborator_id,
    displayName: row.display_name,
    username: row.username,
    job: row.job,
    panelRole,
    modules: modulesForAccess(row.job, row.work_area ?? null, panelRole, {
      vendas: row.allow_vendas ?? null,
      estoque: row.allow_estoque ?? null,
      entregas: row.allow_entregas ?? null,
      financeiro: row.allow_financeiro ?? null,
    }),
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

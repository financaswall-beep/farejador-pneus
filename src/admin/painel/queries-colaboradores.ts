// Obra 300 (2026-07-05; refatiado 2026-07-12): colaboradores da matriz (0124) — CADASTRO.
// O ciclo de ACESSO (papel do painel 0132, revogar/reativar, troca de senha) mora em
// ./queries-colaboradores-acesso.ts — o arquivo passou do teto de 300 quando a 0132
// trouxe panel_role + revogação de sessão; corte por ASSUNTO, não tesourada.
// Porta de entrada continua sendo ./queries.js (barrel) — importadores não mudam.
import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { hashPassword } from '../../parceiro/password.js';

export type MatrizCollaboratorJob = 'vendedor' | 'entregador';
export type MatrizPanelRole = 'owner' | 'admin';

export interface MatrizCollaborator {
  id: string;
  display_name: string;
  username: string;
  job: MatrizCollaboratorJob;
  panel_role: MatrizPanelRole | null;
  active: boolean;
  created_at: string;
  revoked_at: string | null;
}

/** Username já em uso na rede (23505 no índice único da porta única, 0095). */
export class MatrizCollaboratorUsernameTakenError extends Error {
  readonly code = 'username_taken';
  constructor() {
    super('username_taken');
  }
}

export function isPeopleUsernameConflict(err: unknown): boolean {
  return (err as { code?: string })?.code === '23505'
    && String((err as { constraint?: string })?.constraint ?? '').includes('username');
}

export async function listMatrizCollaborators(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<MatrizCollaborator[]> {
  const res = await dbPool.query<{
    id: string; display_name: string; username: string; job: MatrizCollaboratorJob;
    panel_role: MatrizPanelRole | null;
    created_at: string; revoked_at: string | null;
  }>(
    `SELECT mc.id, mc.display_name, pp.username, mc.job, mc.panel_role, mc.created_at, mc.revoked_at
       FROM network.matriz_collaborators mc
       JOIN network.partner_people pp ON pp.id = mc.person_id
      WHERE mc.environment = $1
      ORDER BY (mc.revoked_at IS NULL) DESC, mc.created_at DESC`,
    [environment],
  );
  return res.rows.map((r) => ({ ...r, active: r.revoked_at === null }));
}

export interface CreateMatrizCollaboratorInput {
  environment?: 'prod' | 'test';
  display_name: string;
  username: string;
  password: string;
  job: MatrizCollaboratorJob;
  panel_role?: MatrizPanelRole | null;
  actor_label?: string | null;
}

/** Cria o colaborador: pessoa da porta única (0095) + vínculo 0124, atômico. */
export async function createMatrizCollaborator(
  input: CreateMatrizCollaboratorInput,
  dbPool: Pool = defaultPool,
): Promise<{ id: string; username: string }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const cleanUsername = input.username.trim();
  const passwordHash = await hashPassword(input.password);
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const person = await client.query<{ id: string }>(
      `INSERT INTO network.partner_people (environment, username, password_hash, password_set_at)
       VALUES ($1, $2, $3, now())
       RETURNING id`,
      [environment, cleanUsername, passwordHash],
    );
    const collab = await client.query<{ id: string }>(
      `INSERT INTO network.matriz_collaborators (environment, person_id, display_name, job, panel_role, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [environment, person.rows[0]!.id, input.display_name.trim(), input.job, input.panel_role ?? null, input.actor_label ?? null],
    );
    await client.query('COMMIT');
    return { id: collab.rows[0]!.id, username: cleanUsername };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (isPeopleUsernameConflict(err)) throw new MatrizCollaboratorUsernameTakenError();
    throw err;
  } finally {
    client.release();
  }
}

export async function updateMatrizCollaboratorJob(
  input: { environment?: 'prod' | 'test'; id: string; job: MatrizCollaboratorJob },
  dbPool: Pool = defaultPool,
): Promise<{ updated: boolean }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const res = await dbPool.query(
    `UPDATE network.matriz_collaborators
        SET job = $3
      WHERE id = $2 AND environment = $1 AND revoked_at IS NULL`,
    [environment, input.id, input.job],
  );
  return { updated: (res.rowCount ?? 0) > 0 };
}

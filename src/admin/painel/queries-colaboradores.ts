// Obra 300 (2026-07-05): fatia do banco da MATRIZ — colaboradores da matriz (0124): CRUD + senha + revogar.
// VERBATIM das linhas 3043-3276 do queries.ts pré-obra (commit 2628748).
// Porta de entrada continua sendo ./queries.js (barrel) — importadores não mudam.
import type { Pool, PoolClient } from 'pg';
import { randomBytes } from 'node:crypto';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { normalizeBrazilianPhone } from '../../shared/phone.js';
import { applyWholesaleStockDecrement, applyWholesaleStockReturn } from './wholesale-stock.js';
import { resolveMeasureInCatalog } from './wholesale-catalog.js';
import { applyMatrizGalpaoDecrement, applyMatrizGalpaoReturn, applyMatrizRetailCostSnapshot } from '../../atendente-v2/wholesale-stock-read.js';
import { hashPassword } from '../../parceiro/password.js';

export type MatrizCollaboratorJob = 'vendedor' | 'entregador';

export interface MatrizCollaborator {
  id: string;
  display_name: string;
  username: string;
  job: MatrizCollaboratorJob;
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

function isPeopleUsernameConflict(err: unknown): boolean {
  return (err as { code?: string })?.code === '23505'
    && String((err as { constraint?: string })?.constraint ?? '').includes('username');
}

export async function listMatrizCollaborators(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<MatrizCollaborator[]> {
  const res = await dbPool.query<{
    id: string; display_name: string; username: string; job: MatrizCollaboratorJob;
    created_at: string; revoked_at: string | null;
  }>(
    `SELECT mc.id, mc.display_name, pp.username, mc.job, mc.created_at, mc.revoked_at
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
      `INSERT INTO network.matriz_collaborators (environment, person_id, display_name, job, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [environment, person.rows[0]!.id, input.display_name.trim(), input.job, input.actor_label ?? null],
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

/**
 * Revoga o colaborador (trilha fica). A PESSOA também é revogada — libera o
 * username — mas SÓ se ela não tiver nenhum vínculo ativo de loja (defesa:
 * colaborador desta fatia nasce sem loja, mas não custa provar).
 */
export async function revokeMatrizCollaborator(
  input: { environment?: 'prod' | 'test'; id: string },
  dbPool: Pool = defaultPool,
): Promise<{ revoked: boolean }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query<{ person_id: string }>(
      `UPDATE network.matriz_collaborators
          SET revoked_at = now()
        WHERE id = $2 AND environment = $1 AND revoked_at IS NULL
        RETURNING person_id`,
      [environment, input.id],
    );
    const personId = res.rows[0]?.person_id ?? null;
    if (!personId) {
      await client.query('ROLLBACK');
      return { revoked: false };
    }
    await client.query(
      `UPDATE network.partner_people pp
          SET revoked_at = now()
        WHERE pp.id = $1 AND pp.revoked_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM network.partner_access_tokens pat
                           WHERE pat.person_id = pp.id AND pat.revoked_at IS NULL)`,
      [personId],
    );
    // 0125: mata as sessões do portal /entregas na hora (defesa em profundidade —
    // o middleware do portal já morre pelo JOIN do colaborador; isto apaga a linha viva).
    await client.query(
      `UPDATE network.matriz_staff_sessions SET revoked_at = now()
        WHERE person_id = $1 AND revoked_at IS NULL`,
      [personId],
    );
    await client.query('COMMIT');
    return { revoked: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Reativa um colaborador revogado (mesmo login/senha de antes). Pode falhar com
 * username_taken se o nome de usuário foi reaproveitado por outra conta ativa
 * enquanto este esteve revogado (índice único parcial da 0095).
 */
export async function reactivateMatrizCollaborator(
  input: { environment?: 'prod' | 'test'; id: string },
  dbPool: Pool = defaultPool,
): Promise<{ reactivated: boolean }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const row = await client.query<{ person_id: string }>(
      `SELECT person_id FROM network.matriz_collaborators
        WHERE id = $2 AND environment = $1 AND revoked_at IS NOT NULL
        FOR UPDATE`,
      [environment, input.id],
    );
    const personId = row.rows[0]?.person_id ?? null;
    if (!personId) {
      await client.query('ROLLBACK');
      return { reactivated: false };
    }
    await client.query(
      `UPDATE network.partner_people SET revoked_at = NULL
        WHERE id = $1 AND revoked_at IS NOT NULL`,
      [personId],
    );
    await client.query(
      `UPDATE network.matriz_collaborators SET revoked_at = NULL
        WHERE id = $2 AND environment = $1`,
      [environment, input.id],
    );
    await client.query('COMMIT');
    return { reactivated: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (isPeopleUsernameConflict(err)) throw new MatrizCollaboratorUsernameTakenError();
    throw err;
  } finally {
    client.release();
  }
}

/** Troca a senha do colaborador ativo (a senha é DA PESSOA — porta única). */
export async function resetMatrizCollaboratorPassword(
  input: { environment?: 'prod' | 'test'; id: string; password: string },
  dbPool: Pool = defaultPool,
): Promise<{ reset: boolean }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const passwordHash = await hashPassword(input.password);
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query<{ id: string }>(
      `UPDATE network.partner_people pp
          SET password_hash = $3, password_set_at = now()
         FROM network.matriz_collaborators mc
        WHERE mc.id = $2 AND mc.environment = $1 AND mc.revoked_at IS NULL
          AND pp.id = mc.person_id AND pp.revoked_at IS NULL
        RETURNING pp.id`,
      [environment, input.id, passwordHash],
    );
    const personId = res.rows[0]?.id ?? null;
    // Espelho nos vínculos de loja da pessoa (hoje zero — colaborador não tem
    // loja; defesa pro futuro multi-papel, mesmo padrão do reset do parceiro).
    if (personId) {
      await client.query(
        `UPDATE network.partner_access_tokens
            SET login_password_hash = $2, login_password_set_at = now()
          WHERE person_id = $1 AND revoked_at IS NULL`,
        [personId, passwordHash],
      );
    }
    await client.query('COMMIT');
    return { reset: personId !== null };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

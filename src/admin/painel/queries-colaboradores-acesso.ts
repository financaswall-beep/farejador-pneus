// Colaboradores da matriz (0124/0132) — ciclo de ACESSO: papel do painel,
// revogar/reativar e troca de senha. Fatiado de ./queries-colaboradores.ts em
// 2026-07-12 (o arquivo passou do teto de 300 com a 0132; corte por ASSUNTO —
// aqui mora tudo que MEXE em sessão/permissão; lá fica o cadastro).
// Porta de entrada continua sendo ./queries.js (barrel) — importadores não mudam.
import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { hashPassword } from '../../parceiro/password.js';
import {
  MatrizCollaboratorUsernameTakenError,
  isPeopleUsernameConflict,
  type MatrizPanelRole,
} from './queries-colaboradores.js';

export class MatrizLastOwnerError extends Error {
  constructor() { super('last_owner_required'); }
}

async function lockAndProtectLastOwner(
  client: PoolClient,
  environment: 'prod' | 'test',
  collaboratorId: string,
  nextRole: MatrizPanelRole | null,
): Promise<{ found: boolean; personId: string | null }> {
  const target = await client.query<{ person_id: string; panel_role: MatrizPanelRole | null }>(
    `SELECT person_id, panel_role FROM network.matriz_collaborators
      WHERE environment = $1 AND id = $2 AND revoked_at IS NULL
      FOR UPDATE`,
    [environment, collaboratorId],
  );
  const row = target.rows[0];
  if (!row) return { found: false, personId: null };
  if (row.panel_role === 'owner' && nextRole !== 'owner') {
    const owners = await client.query(
      `SELECT id FROM network.matriz_collaborators
        WHERE environment = $1 AND panel_role = 'owner' AND revoked_at IS NULL
        FOR UPDATE`,
      [environment],
    );
    if (owners.rows.length <= 1) throw new MatrizLastOwnerError();
  }
  return { found: true, personId: row.person_id };
}

export async function updateMatrizCollaboratorPanelRole(
  input: { environment?: 'prod' | 'test'; id: string; panel_role: MatrizPanelRole | null },
  dbPool: Pool = defaultPool,
): Promise<{ updated: boolean }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const target = await lockAndProtectLastOwner(client, environment, input.id, input.panel_role);
    if (!target.found) {
      await client.query('ROLLBACK');
      return { updated: false };
    }
    await client.query(
      `UPDATE network.matriz_collaborators SET panel_role = $3
        WHERE environment = $1 AND id = $2 AND revoked_at IS NULL`,
      [environment, input.id, input.panel_role],
    );
    await client.query(
      `UPDATE network.matriz_staff_sessions SET revoked_at = now()
        WHERE person_id = $1 AND revoked_at IS NULL`,
      [target.personId],
    );
    await client.query('COMMIT');
    return { updated: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
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
    const target = await lockAndProtectLastOwner(client, environment, input.id, null);
    if (!target.found) {
      await client.query('ROLLBACK');
      return { revoked: false };
    }
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
      await client.query(
        `UPDATE network.matriz_staff_sessions SET revoked_at = now()
          WHERE person_id = $1 AND revoked_at IS NULL`,
        [personId],
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

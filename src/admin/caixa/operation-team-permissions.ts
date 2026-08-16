import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import type { OperationPermissionsPayload } from '../../shared/operation-team.js';

type Queryable = Pick<Pool, 'query'>;
type PermissionInput = { vendas: boolean; estoque: boolean; entregas: boolean; financeiro: boolean };
type Row = {
  id: string; person_id: string; display_name: string; username: string;
  job: string; job_title: string | null; panel_role: 'owner' | 'admin' | null;
  active: boolean; allow_vendas: boolean; allow_estoque: boolean;
  allow_entregas: boolean; allow_financeiro: boolean;
};

async function findPermissions(
  collaboratorId: string,
  db: Queryable,
): Promise<Row | null> {
  const result = await db.query<Row>(
    `SELECT mc.id,mc.person_id,mc.display_name,pp.username,mc.job,mc.job_title,
            mc.panel_role,mc.revoked_at IS NULL active,
            CASE WHEN mc.panel_role='owner'
                 THEN true
                 ELSE COALESCE(op.allow_vendas,mc.job='vendedor' AND mc.work_area='sales') END allow_vendas,
            CASE WHEN mc.panel_role='owner' THEN true
                 ELSE COALESCE(op.allow_estoque,mc.job='vendedor' AND mc.work_area='sales') END allow_estoque,
            CASE WHEN mc.panel_role='owner' THEN true
                 ELSE COALESCE(op.allow_entregas,mc.job='entregador') END allow_entregas,
            CASE WHEN mc.panel_role='owner' THEN true
                 ELSE COALESCE(op.allow_financeiro,mc.panel_role IS NOT NULL) END allow_financeiro
       FROM network.matriz_collaborators mc
       JOIN network.partner_people pp
         ON pp.id=mc.person_id AND pp.environment=mc.environment
       LEFT JOIN network.matriz_collaborator_operation_permissions op
         ON op.collaborator_id=mc.id AND op.environment=mc.environment
      WHERE mc.environment=$1 AND mc.id=$2
      LIMIT 1`,
    [env.FAREJADOR_ENV, collaboratorId],
  );
  return result.rows[0] ?? null;
}

function payload(row: Row): OperationPermissionsPayload {
  return {
    unit_name: 'Matriz',
    member: {
      id: row.id, name: row.display_name, username: row.username,
      role: row.job_title || row.panel_role || row.job, active: row.active,
    },
    permissions: {
      vendas: row.allow_vendas,
      estoque: row.allow_estoque,
      entregas: row.allow_entregas,
      financeiro: row.allow_financeiro,
    },
    available_permissions: ['vendas', 'estoque', 'entregas', 'financeiro'],
    locked: row.panel_role === 'owner',
  };
}

export async function getMatrizOperationPermissions(
  collaboratorId: string,
  db: Queryable = defaultPool,
): Promise<OperationPermissionsPayload | null> {
  const row = await findPermissions(collaboratorId, db);
  return row ? payload(row) : null;
}

export async function saveMatrizOperationPermissions(
  collaboratorId: string,
  input: PermissionInput,
  actorLabel: string,
  db: Pool = defaultPool,
): Promise<OperationPermissionsPayload> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const target = await client.query<{ person_id: string; panel_role: string | null }>(
      `SELECT person_id,panel_role FROM network.matriz_collaborators
        WHERE environment=$1 AND id=$2 AND revoked_at IS NULL FOR UPDATE`,
      [env.FAREJADOR_ENV, collaboratorId],
    );
    const row = target.rows[0];
    if (!row) throw new Error('collaborator_not_found');
    if (row.panel_role === 'owner') throw new Error('owner_permissions_locked');
    await client.query(
      `INSERT INTO network.matriz_collaborator_operation_permissions
         (collaborator_id,environment,allow_vendas,allow_estoque,allow_entregas,allow_financeiro,updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (collaborator_id) DO UPDATE SET
         allow_vendas=EXCLUDED.allow_vendas,allow_estoque=EXCLUDED.allow_estoque,
         allow_entregas=EXCLUDED.allow_entregas,
         allow_financeiro=EXCLUDED.allow_financeiro,updated_by=EXCLUDED.updated_by,updated_at=now()`,
      [collaboratorId, env.FAREJADOR_ENV, input.vendas, input.estoque,
       input.entregas, input.financeiro, actorLabel],
    );
    await client.query(
      `UPDATE network.matriz_staff_sessions SET revoked_at=now()
        WHERE environment=$1 AND person_id=$2 AND revoked_at IS NULL`,
      [env.FAREJADOR_ENV, row.person_id],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
  const saved = await getMatrizOperationPermissions(collaboratorId, db);
  if (!saved) throw new Error('collaborator_not_found');
  return saved;
}

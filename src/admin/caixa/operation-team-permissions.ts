import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import type { OperationPermissionsPayload } from '../../shared/operation-team.js';
import { MATRIX_PANEL_MODULES, type MatrixPanelModule } from '../panel-modules.js';

type Queryable = Pick<Pool, 'query'>;
type PermissionInput = Record<MatrixPanelModule, boolean>;
type Row = {
  id: string; person_id: string; display_name: string; username: string;
  job: string; job_title: string | null; panel_role: 'owner' | 'admin' | null;
  active: boolean;
  allow_resumo: boolean; allow_bot: boolean; allow_vendas: boolean;
  allow_retiradas: boolean; allow_clientes: boolean; allow_compras: boolean;
  allow_estoque: boolean; allow_logistica: boolean; allow_financeiro: boolean;
  allow_rede: boolean; allow_marketing: boolean; allow_colaboradores: boolean;
  allow_catalogo: boolean;
};

async function findPermissions(
  collaboratorId: string,
  db: Queryable,
): Promise<Row | null> {
  const result = await db.query<Row>(
    `SELECT mc.id,mc.person_id,mc.display_name,pp.username,mc.job,mc.job_title,
            mc.panel_role,mc.revoked_at IS NULL active,
            CASE WHEN mc.panel_role='owner' THEN true
                 ELSE COALESCE(op.allow_resumo,mc.panel_role IS NOT NULL) END allow_resumo,
            CASE WHEN mc.panel_role='owner' THEN true
                 ELSE COALESCE(op.allow_bot,mc.panel_role IS NOT NULL) END allow_bot,
            CASE WHEN mc.panel_role='owner'
                 THEN true
                 ELSE COALESCE(op.allow_vendas,mc.job='vendedor' AND mc.work_area='sales') END allow_vendas,
            CASE WHEN mc.panel_role='owner' THEN true
                 ELSE COALESCE(op.allow_retiradas,false) END allow_retiradas,
            CASE WHEN mc.panel_role='owner' THEN true
                 ELSE COALESCE(op.allow_clientes,mc.panel_role IS NOT NULL) END allow_clientes,
            CASE WHEN mc.panel_role='owner' THEN true
                 ELSE COALESCE(op.allow_compras,mc.panel_role IS NOT NULL) END allow_compras,
            CASE WHEN mc.panel_role='owner' THEN true
                 ELSE COALESCE(op.allow_estoque,mc.job='vendedor' AND mc.work_area='sales') END allow_estoque,
            CASE WHEN mc.panel_role='owner' THEN true
                 ELSE COALESCE(op.allow_logistica,op.allow_entregas,mc.job='entregador') END allow_logistica,
            CASE WHEN mc.panel_role='owner' THEN true
                 ELSE COALESCE(op.allow_financeiro,mc.panel_role IS NOT NULL) END allow_financeiro,
            CASE WHEN mc.panel_role='owner' THEN true
                 ELSE COALESCE(op.allow_rede,mc.panel_role IS NOT NULL) END allow_rede,
            CASE WHEN mc.panel_role='owner' THEN true
                 ELSE COALESCE(op.allow_marketing,false) END allow_marketing,
            CASE WHEN mc.panel_role='owner' THEN true
                 ELSE COALESCE(op.allow_colaboradores,false) END allow_colaboradores,
            CASE WHEN mc.panel_role='owner' THEN true
                 ELSE COALESCE(op.allow_catalogo,mc.panel_role IS NOT NULL) END allow_catalogo
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
      resumo: row.allow_resumo, bot: row.allow_bot, vendas: row.allow_vendas,
      retiradas: row.allow_retiradas, clientes: row.allow_clientes,
      compras: row.allow_compras, estoque: row.allow_estoque,
      logistica: row.allow_logistica, financeiro: row.allow_financeiro,
      rede: row.allow_rede, marketing: row.allow_marketing,
      colaboradores: row.allow_colaboradores, catalogo: row.allow_catalogo,
    },
    available_permissions: [...MATRIX_PANEL_MODULES],
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
         (collaborator_id,environment,allow_resumo,allow_bot,allow_vendas,
          allow_retiradas,allow_clientes,allow_compras,allow_estoque,
          allow_entregas,allow_logistica,allow_financeiro,allow_rede,
          allow_marketing,allow_colaboradores,allow_catalogo,updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (collaborator_id) DO UPDATE SET
         allow_resumo=EXCLUDED.allow_resumo,allow_bot=EXCLUDED.allow_bot,
         allow_vendas=EXCLUDED.allow_vendas,allow_retiradas=EXCLUDED.allow_retiradas,
         allow_clientes=EXCLUDED.allow_clientes,allow_compras=EXCLUDED.allow_compras,
         allow_estoque=EXCLUDED.allow_estoque,allow_entregas=EXCLUDED.allow_entregas,
         allow_logistica=EXCLUDED.allow_logistica,allow_financeiro=EXCLUDED.allow_financeiro,
         allow_rede=EXCLUDED.allow_rede,allow_marketing=EXCLUDED.allow_marketing,
         allow_colaboradores=EXCLUDED.allow_colaboradores,allow_catalogo=EXCLUDED.allow_catalogo,
         updated_by=EXCLUDED.updated_by,updated_at=now()`,
      [collaboratorId, env.FAREJADOR_ENV, input.resumo, input.bot, input.vendas,
       input.retiradas, input.clientes, input.compras, input.estoque,
       input.logistica, input.financeiro, input.rede, input.marketing,
       input.colaboradores, input.catalogo, actorLabel],
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

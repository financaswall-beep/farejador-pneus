import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { authenticatePersonCredentials } from '../../parceiro/people.js';

export interface OperationModules {
  vendas: boolean;
  estoque: boolean;
  entregas: boolean;
  retiradas: boolean;
  financeiro: boolean;
}

export type OperationWorkplace =
  | {
      id: 'matrix';
      kind: 'matrix';
      name: 'Matriz';
      role: 'owner' | 'admin' | 'vendedor' | 'entregador' | 'colaborador';
      collaboratorId: string;
      modules: OperationModules;
    }
  | {
      id: string;
      kind: 'partner';
      name: string;
      role: string;
      slug: string;
      tokenId: string;
      displayName: string;
      modernPanelEnabled: boolean;
      modules: OperationModules;
    };

export interface OperationAuthResult {
  personId: string;
  username: string;
  workplaces: OperationWorkplace[];
}

export interface PanelAuthResult extends OperationAuthResult {
  workplaces: OperationWorkplace[];
}

type MatrixRow = {
  collaborator_id: string;
  job: 'vendedor' | 'entregador' | 'colaborador';
  work_area: string | null;
  panel_role: 'owner' | 'admin' | null;
  allow_vendas: boolean | null;
  allow_estoque: boolean | null;
  allow_entregas: boolean | null;
  allow_retiradas: boolean | null;
  allow_financeiro: boolean | null;
};

type PartnerRow = {
  token_id: string;
  slug: string;
  store_name: string;
  role: string;
  display_name: string;
  modern_panel_enabled: boolean;
  allow_vendas: boolean;
  allow_estoque: boolean;
  allow_entregas: boolean;
  allow_retiradas: boolean;
  allow_financeiro: boolean;
};

/**
 * Lista exclusivamente os locais de trabalho ativos da pessoa autenticada.
 *
 * O identificador técnico do vínculo nunca sai no JSON. Para parceiros, a
 * permissão por pessoa prevalece sobre a permissão da loja e os defaults atuais
 * são mantidos. Um funcionário sem nenhum módulo da Operação não recebe esta
 * porta, mesmo que ainda possua acesso a outras telas administrativas.
 */
export async function listOperationWorkplaces(
  environment: string,
  personId: string,
  dbPool: Pool = defaultPool,
): Promise<OperationWorkplace[]> {
  const [matrix, partners] = await Promise.all([
    dbPool.query<MatrixRow>(
      `SELECT mc.id AS collaborator_id, mc.job, mc.work_area, mc.panel_role,
              op.allow_vendas,op.allow_estoque,op.allow_entregas,
              op.allow_retiradas,op.allow_financeiro
         FROM network.matriz_collaborators mc
         LEFT JOIN network.matriz_collaborator_operation_permissions op
           ON op.collaborator_id=mc.id AND op.environment=mc.environment
        WHERE mc.environment = $1
          AND mc.person_id = $2
          AND mc.revoked_at IS NULL
          AND (mc.panel_role IS NOT NULL
            OR (mc.job = 'vendedor' AND mc.work_area = 'sales')
            OR mc.job = 'entregador'
            OR COALESCE(op.allow_vendas,false)
            OR COALESCE(op.allow_estoque,false)
            OR COALESCE(op.allow_entregas,false)
            OR COALESCE(op.allow_retiradas,false)
            OR COALESCE(op.allow_financeiro,false))
        LIMIT 1`,
      [environment, personId],
    ),
    dbPool.query<PartnerRow>(
      `SELECT pat.id AS token_id,
              pu.slug,
              COALESCE(pu.display_name, u.name) AS store_name,
              pat.role,
              COALESCE(NULLIF(btrim(pat.label), ''), pp.username) AS display_name,
              pu.modern_panel_enabled,
              CASE WHEN pat.role = 'owner' THEN true
                   ELSE COALESCE(ptp.allow_vendas, pup.allow_vendas, true) END AS allow_vendas,
              CASE WHEN pat.role = 'owner' THEN true
                   ELSE COALESCE(ptp.allow_estoque, pup.allow_estoque, true) END AS allow_estoque,
              CASE WHEN pat.role = 'owner' THEN true
                   ELSE COALESCE(ptp.allow_entregas, pup.allow_entregas, true) END AS allow_entregas
              ,CASE WHEN pat.role = 'owner' THEN true
                    ELSE COALESCE(ptp.allow_retiradas, pup.allow_retiradas, true) END AS allow_retiradas
              ,CASE WHEN pat.role = 'owner' THEN true
                    ELSE COALESCE(ptp.allow_financeiro, pup.allow_financeiro, false) END AS allow_financeiro
         FROM network.partner_access_tokens pat
         JOIN network.partner_units pu
           ON pu.id = pat.partner_unit_id AND pu.environment = pat.environment
         JOIN network.partners p
           ON p.id = pu.partner_id AND p.environment = pu.environment
         JOIN network.partner_people pp
           ON pp.id = pat.person_id AND pp.environment = pat.environment
         JOIN core.units u ON u.id = pu.unit_id
         LEFT JOIN network.partner_token_permissions ptp
           ON ptp.token_id = pat.id AND ptp.environment = pat.environment
         LEFT JOIN network.partner_unit_permissions pup
           ON pup.partner_unit_id = pu.id AND pup.environment = pu.environment
        WHERE pat.environment = $1
          AND pat.person_id = $2
          AND pat.revoked_at IS NULL
          AND pu.status = 'active' AND p.status = 'active'
          AND pu.deleted_at IS NULL AND p.deleted_at IS NULL
        ORDER BY store_name ASC`,
      [environment, personId],
    ),
  ]);

  const workplaces: OperationWorkplace[] = [];
  const matrixRow = matrix.rows[0];
  if (matrixRow) {
    const isCourier = matrixRow.job === 'entregador';
    const canSell = matrixRow.job === 'vendedor' && matrixRow.work_area === 'sales';
    const panelRole = matrixRow.panel_role ?? null;
    const modules = matrixRow.panel_role === 'owner' ? {
      vendas: true, estoque: true, entregas: true, retiradas: true, financeiro: true,
    } : {
      vendas: matrixRow.allow_vendas ?? canSell,
      estoque: matrixRow.allow_estoque ?? canSell,
      entregas: matrixRow.allow_entregas ?? isCourier,
      retiradas: matrixRow.allow_retiradas ?? false,
      financeiro: matrixRow.allow_financeiro ?? (panelRole !== null),
    };
    if (modules.vendas || modules.estoque || modules.entregas || modules.retiradas || modules.financeiro) workplaces.push({
      id: 'matrix',
      kind: 'matrix',
      name: 'Matriz',
      role: panelRole ?? matrixRow.job,
      collaboratorId: matrixRow.collaborator_id,
      modules,
    });
  }

  for (const row of partners.rows) {
    const canSeeFinance = row.role === 'owner' || row.allow_financeiro === true;
    const canSeePickups = row.allow_retiradas === true;
    if (!row.allow_vendas && !row.allow_estoque && !row.allow_entregas
      && !canSeePickups && !canSeeFinance) continue;
    workplaces.push({
      id: `partner:${row.slug}`,
      kind: 'partner',
      name: row.store_name,
      role: row.role,
      slug: row.slug,
      tokenId: row.token_id,
      displayName: row.display_name,
      modernPanelEnabled: row.modern_panel_enabled === true,
      modules: {
        vendas: row.allow_vendas,
        estoque: row.allow_estoque,
        entregas: row.allow_entregas,
        retiradas: canSeePickups,
        financeiro: canSeeFinance,
      },
    });
  }
  return workplaces;
}

export async function authenticateOperation(
  environment: string,
  username: string,
  password: string,
  dbPool: Pool = defaultPool,
): Promise<OperationAuthResult | null> {
  const person = await authenticatePersonCredentials(environment, username, password, dbPool);
  if (!person) return null;
  const workplaces = await listOperationWorkplaces(environment, person.personId, dbPool);
  if (workplaces.length === 0) return null;
  return { personId: person.personId, username: person.username, workplaces };
}

/**
 * Porta do painel moderno. A Matriz só aparece para quem realmente possui
 * panel_role; vendedores e entregadores continuam exclusivamente na Operação.
 * Parceiros usam os mesmos vínculos já resolvidos para o /operacao.
 */
export async function authenticatePanelAccess(
  environment: string,
  username: string,
  password: string,
  dbPool: Pool = defaultPool,
): Promise<PanelAuthResult | null> {
  const person = await authenticatePersonCredentials(environment, username, password, dbPool);
  if (!person) return null;
  const workplaces = (await listOperationWorkplaces(environment, person.personId, dbPool))
    .filter((workplace) => workplace.kind === 'partner'
      || workplace.role === 'owner' || workplace.role === 'admin');
  if (workplaces.length === 0) return null;
  return { personId: person.personId, username: person.username, workplaces };
}

export function publicOperationWorkplace(workplace: OperationWorkplace) {
  return {
    id: workplace.id,
    kind: workplace.kind,
    name: workplace.name,
    role: workplace.role,
  };
}

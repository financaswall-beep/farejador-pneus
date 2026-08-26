import type { Pool } from 'pg';
import type { OperationTeamMember } from '../shared/operation-team.js';
import type { PartnerContext } from './auth.js';
import { withPartnerContext } from './db.js';

type Queryable = Pick<Pool, 'query'>;

type PartnerDirectoryRow = {
  id: string;
  name: string;
  active: boolean;
  role_name: string;
  job_role: 'vendedor' | 'estoque' | 'entregador' | 'colaborador';
};

export interface PartnerOperationTeamDirectoryPayload {
  unit_name: string;
  active_count: number;
  members: Array<Pick<OperationTeamMember, 'id' | 'name' | 'role' | 'work_area' | 'active'>>;
}

/**
 * Diretório mínimo para funcionário com acesso à tela Colaboradores.
 * Não consulta nem devolve salário, benefício, comissão, usuário ou permissões.
 * A visão financeira completa continua exclusiva do proprietário da unidade.
 */
export async function getPartnerOperationTeamDirectory(
  ctx: PartnerContext,
  db?: Queryable,
): Promise<PartnerOperationTeamDirectoryPayload> {
  if (!db) {
    return withPartnerContext(ctx.partnerUnitId, async (client) => (
      getPartnerOperationTeamDirectory(ctx, client)
    ));
  }
  const result = await db.query<PartnerDirectoryRow>(
    `SELECT id,name,active,job_role,role_name
       FROM network.partner_staff_directory()
      ORDER BY active DESC,name`,
  );
  const members = result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    role: row.role_name,
    work_area: row.job_role === 'entregador' ? 'delivery'
      : row.job_role === 'estoque' ? 'stock'
        : row.job_role === 'vendedor' ? 'sales' : 'other',
    active: row.active,
  }));
  return {
    unit_name: ctx.unitName,
    active_count: members.filter((row) => row.active).length,
    members,
  };
}

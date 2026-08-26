import type { Pool } from 'pg';
import { pool as defaultPool } from '../persistence/db.js';
import type { OperationPermissionsPayload } from '../shared/operation-team.js';
import type { PartnerContext } from './auth.js';
import {
  getPartnerTokenPermissions,
  upsertPartnerTokenPermissions,
  type PartnerPermissionsInput,
} from './queries.js';

const available = [
  'vendas', 'estoque', 'pedidos', 'clientes', 'entregas',
  'retiradas', 'batepapo', 'resumo', 'financeiro',
  'compras', 'colaboradores', 'catalogo',
] as const;

type JobRole = 'vendedor' | 'estoque' | 'entregador' | 'colaborador';
type Queryable = Pick<Pool, 'query'>;

function roleName(role: JobRole): string {
  return role === 'vendedor' ? 'Vendedor' : role === 'estoque' ? 'Estoque'
    : role === 'entregador' ? 'Entregador' : 'Colaborador';
}

async function member(ctx: PartnerContext, tokenId: string, db: Pick<Pool, 'query'>) {
  const result = await db.query<{
    id: string; name: string; username: string | null; active: boolean; job_role: JobRole;
  }>(
    `SELECT pat.id,COALESCE(NULLIF(btrim(pat.label),''),pat.login_username,'Colaborador') name,
            pat.login_username username,pat.revoked_at IS NULL active,pat.job_role
       FROM network.partner_access_tokens pat
      WHERE pat.environment=$1 AND pat.partner_unit_id=$2 AND pat.id=$3
        AND pat.role='funcionario' LIMIT 1`,
    [ctx.environment, ctx.partnerUnitId, tokenId],
  );
  return result.rows[0] ?? null;
}

export async function getPartnerOperationPermissions(
  ctx: PartnerContext,
  tokenId: string,
  db: Pick<Pool, 'query'> = defaultPool,
): Promise<OperationPermissionsPayload | null> {
  const person = await member(ctx, tokenId, db);
  if (!person) return null;
  const permissions = await getPartnerTokenPermissions(ctx, tokenId, db);
  return {
    unit_name: ctx.unitName,
    member: { ...person, role: roleName(person.job_role) },
    permissions,
    available_permissions: [...available],
    locked: !person.active,
  };
}

export async function savePartnerOperationPermissions(
  ctx: PartnerContext,
  tokenId: string,
  input: PartnerPermissionsInput,
  db: Pool = defaultPool,
): Promise<OperationPermissionsPayload> {
  return writePartnerOperationPermissions(ctx, tokenId, input, undefined, db);
}

export async function writePartnerOperationPermissions(
  ctx: PartnerContext, tokenId: string, input: PartnerPermissionsInput,
  jobRole: JobRole | undefined, db: Queryable,
): Promise<OperationPermissionsPayload> {
  if (jobRole) {
    const updated = await db.query(
      `UPDATE network.partner_access_tokens SET job_role=$4
        WHERE environment=$1 AND partner_unit_id=$2 AND id=$3
          AND role='funcionario' AND revoked_at IS NULL`,
      [ctx.environment, ctx.partnerUnitId, tokenId, jobRole],
    );
    if ((updated.rowCount ?? 0) !== 1) throw new Error('collaborator_not_found');
  }
  const permissions = await upsertPartnerTokenPermissions(ctx, tokenId, input, db);
  await db.query(
    `UPDATE network.partner_sessions SET revoked_at=now()
      WHERE environment=$1 AND token_id=$2 AND revoked_at IS NULL`,
    [ctx.environment, tokenId],
  );
  const person = await member(ctx, tokenId, db);
  if (!person) throw new Error('collaborator_not_found');
  return {
    unit_name: ctx.unitName,
    member: { ...person, role: roleName(person.job_role) },
    permissions,
    available_permissions: [...available],
    locked: !person.active,
  };
}

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
  'retiradas', 'resumo', 'financeiro',
] as const;

async function member(ctx: PartnerContext, tokenId: string, db: Pick<Pool, 'query'>) {
  const result = await db.query<{
    id: string; name: string; username: string | null; active: boolean;
  }>(
    `SELECT pat.id,COALESCE(NULLIF(btrim(pat.label),''),pat.login_username,'Colaborador') name,
            pat.login_username username,pat.revoked_at IS NULL active
       FROM network.partner_access_tokens pat
      WHERE pat.environment=$1 AND pat.partner_unit_id=$2 AND pat.id=$3
        AND pat.role='funcionario' LIMIT 1`,
    [ctx.environment, ctx.partnerUnitId, tokenId],
  );
  return result.rows[0] ?? null;
}

function roleOf(permissions: PartnerPermissionsInput): string {
  if (permissions.entregas && !permissions.vendas) return 'Entregador';
  if (permissions.vendas) return 'Vendedor';
  return 'Colaborador';
}

export async function getPartnerOperationPermissions(
  ctx: PartnerContext,
  tokenId: string,
  db: Pick<Pool, 'query'> = defaultPool,
): Promise<OperationPermissionsPayload | null> {
  const person = await member(ctx, tokenId, db);
  if (!person) return null;
  const permissions = await getPartnerTokenPermissions(ctx, tokenId);
  return {
    unit_name: ctx.unitName,
    member: { ...person, role: roleOf(permissions) },
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
  const permissions = await upsertPartnerTokenPermissions(ctx, tokenId, {
    ...input,
    // O Bate-papo foi aposentado nos portais. Mantemos a chave legada
    // desligada no banco para não reabrir o módulo por uma tela antiga.
    batepapo: false,
  });
  await db.query(
    `UPDATE network.partner_sessions SET revoked_at=now()
      WHERE environment=$1 AND token_id=$2 AND revoked_at IS NULL`,
    [ctx.environment, tokenId],
  );
  const person = await member(ctx, tokenId, db);
  if (!person) throw new Error('collaborator_not_found');
  return {
    unit_name: ctx.unitName,
    member: { ...person, role: roleOf(permissions) },
    permissions,
    available_permissions: [...available],
    locked: !person.active,
  };
}

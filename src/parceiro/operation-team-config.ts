import { pool as defaultPool } from '../persistence/db.js';
import type { PartnerContext, PartnerPermissions } from './auth.js';
import {
  getPartnerOperationCommissionRule, getPartnerOperationCompensation,
  type PartnerCommissionRuleInput, type PartnerCompensationInput,
  writePartnerOperationCommissionRule, writePartnerOperationCompensation,
} from './operation-team.js';
import {
  getPartnerOperationPermissions, writePartnerOperationPermissions,
} from './operation-team-permissions.js';

export async function savePartnerOperationConfiguration(ctx: PartnerContext, tokenId: string, input: {
  job_role: 'vendedor' | 'estoque' | 'entregador' | 'colaborador';
  permissions: PartnerPermissions;
  compensation: PartnerCompensationInput;
  commission: PartnerCommissionRuleInput;
}, db = defaultPool) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await writePartnerOperationPermissions(
      ctx, tokenId, input.permissions, input.job_role, client,
    );
    await writePartnerOperationCompensation(ctx, tokenId, input.compensation, client);
    await writePartnerOperationCommissionRule(ctx, tokenId, input.commission, client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }

  const [permissions, compensation, commission] = await Promise.all([
    getPartnerOperationPermissions(ctx, tokenId, db),
    getPartnerOperationCompensation(ctx, tokenId, db),
    getPartnerOperationCommissionRule(ctx, tokenId, db),
  ]);
  if (!permissions || !compensation || !commission) throw new Error('collaborator_not_found');
  return { saved: true, permissions, compensation, commission };
}

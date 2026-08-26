import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { saveMatrizOperationCommissionRule } from '../caixa/operation-team.js';
import {
  saveMatrizCollaboratorCompensation,
  type MatrizCompensationInput,
} from './queries-colaboradores-config.js';

type CommissionInput = Parameters<typeof saveMatrizOperationCommissionRule>[0];

/**
 * Salva remuneração e comissão como uma única configuração. Se qualquer
 * metade falhar, nenhuma delas fica gravada — evita um colaborador aparecer
 * com salário novo e regra de comissão antiga (ou o contrário).
 */
export async function saveMatrizFinancialConfiguration(
  compensation: MatrizCompensationInput,
  commission: CommissionInput,
  dbPool: Pool = defaultPool,
): Promise<{ saved: true; collaborator_id: string }> {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    await saveMatrizCollaboratorCompensation(compensation, client);
    await saveMatrizOperationCommissionRule(commission, client);
    await client.query('COMMIT');
    return { saved: true, collaborator_id: compensation.collaborator_id };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

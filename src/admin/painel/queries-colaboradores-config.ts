import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import type {
  OperationBenefit, OperationCommissionItemRules,
} from '../../shared/operation-team.js';

export interface MatrizCompensationInput {
  collaborator_id: string; employment_type: 'clt' | 'mei' | 'autonomo' | 'outro';
  base_salary: number; payment_day: number; payment_method: 'pix' | 'transferencia' | 'dinheiro' | 'outro';
  salary_frequency?: 'weekly' | 'monthly';
  payment_note?: string | null; starts_on: string; benefits?: OperationBenefit[];
  environment?: 'prod' | 'test'; actor_label?: string | null;
}

export async function saveMatrizCollaboratorCompensation(
  input: MatrizCompensationInput, dbPool: Pool = defaultPool,
) {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const r = await dbPool.query(
    `INSERT INTO network.matriz_collaborator_compensation
       (collaborator_id, environment, employment_type, base_salary, payment_day, payment_method,
        payment_note, starts_on, updated_by, benefits, salary_frequency)
     SELECT mc.id, mc.environment, $3, $4, $5, $6, $7, $8::date, $9,
            COALESCE($10::jsonb,'[]'::jsonb),COALESCE($11,'monthly')
       FROM network.matriz_collaborators mc WHERE mc.id=$2 AND mc.environment=$1 AND mc.revoked_at IS NULL
     ON CONFLICT (collaborator_id, starts_on) DO UPDATE SET
       employment_type=EXCLUDED.employment_type, base_salary=EXCLUDED.base_salary,
       payment_day=EXCLUDED.payment_day, payment_method=EXCLUDED.payment_method,
       payment_note=EXCLUDED.payment_note,
       benefits=CASE WHEN $10::jsonb IS NULL
         THEN network.matriz_collaborator_compensation.benefits ELSE EXCLUDED.benefits END,
       salary_frequency=CASE WHEN $11::text IS NULL THEN network.matriz_collaborator_compensation.salary_frequency ELSE EXCLUDED.salary_frequency END,
       updated_by=EXCLUDED.updated_by, updated_at=now()
     RETURNING collaborator_id`,
    [environment, input.collaborator_id, input.employment_type, input.base_salary, input.payment_day,
     input.payment_method, input.payment_note ?? null, input.starts_on, input.actor_label ?? null,
     input.benefits === undefined ? null : JSON.stringify(input.benefits), input.salary_frequency ?? null],
  );
  if (!r.rows[0]) throw new Error('collaborator_not_found');
  return { saved: true, collaborator_id: r.rows[0].collaborator_id };
}

export interface MatrizCommissionInput {
  collaborator_id: string; kind: 'percent' | 'fixed';
  basis: 'margin' | 'revenue' | 'sale' | 'delivery' | 'trip'; value: number;
  starts_on: string; active?: boolean; environment?: 'prod' | 'test'; actor_label?: string | null;
  itemized?: boolean; item_rules?: OperationCommissionItemRules;
  settlement_frequency?: 'weekly' | 'monthly';
}

export async function saveMatrizCollaboratorCommission(
  input: MatrizCommissionInput, dbPool: Pool = defaultPool,
) {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const r = await dbPool.query(
    `INSERT INTO network.matriz_collaborator_commission_rules
       (collaborator_id, environment, kind, basis, value, starts_on, active, updated_by,
        itemized,item_rules,settlement_frequency)
     SELECT mc.id, mc.environment, $3, $4, $5, $6::date, $7, $8,$9,
            COALESCE($10::jsonb,'{}'::jsonb),$11
       FROM network.matriz_collaborators mc WHERE mc.id=$2 AND mc.environment=$1 AND mc.revoked_at IS NULL
     ON CONFLICT (collaborator_id, starts_on) DO UPDATE SET kind=EXCLUDED.kind, basis=EXCLUDED.basis,
       value=EXCLUDED.value, active=EXCLUDED.active,
       itemized=EXCLUDED.itemized,item_rules=EXCLUDED.item_rules,
       settlement_frequency=EXCLUDED.settlement_frequency,
       updated_by=EXCLUDED.updated_by, updated_at=now()
     RETURNING collaborator_id`,
    [environment, input.collaborator_id, input.kind, input.basis, input.value, input.starts_on,
     input.active ?? true, input.actor_label ?? null, input.itemized ?? false,
     JSON.stringify(input.item_rules ?? {}), input.settlement_frequency ?? 'monthly'],
  );
  if (!r.rows[0]) throw new Error('collaborator_not_found');
  return { saved: true, collaborator_id: r.rows[0].collaborator_id };
}

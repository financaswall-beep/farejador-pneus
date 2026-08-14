export interface OperationBenefit {
  name: string;
  amount: number;
  active: boolean;
}

export type OperationCommissionKind = 'percent' | 'fixed';
export type OperationCommissionBasis = 'margin' | 'revenue' | 'sale' | 'delivery' | 'trip';

export interface OperationTeamMember {
  id: string;
  name: string;
  username: string | null;
  role: string;
  work_area: string;
  active: boolean;
  base_salary: number;
  benefits_total: number;
  payment_day: number | null;
  compensation_starts_on: string | null;
  commission_kind: OperationCommissionKind | null;
  commission_basis: OperationCommissionBasis | null;
  commission_value: number;
  commission_active: boolean;
  commission_amount: number;
}

export interface OperationTeamPayload {
  unit_name: string;
  active_count: number;
  commission_total: number;
  members: OperationTeamMember[];
}

export interface OperationCompensationPayload {
  unit_name: string;
  member: Pick<OperationTeamMember, 'id' | 'name' | 'username' | 'role' | 'active'>;
  employment_type: 'clt' | 'mei' | 'autonomo' | 'outro';
  base_salary: number;
  payment_day: number;
  payment_method: 'pix' | 'transferencia' | 'dinheiro' | 'outro';
  starts_on: string;
  benefits: OperationBenefit[];
  benefits_total: number;
  fixed_total: number;
}

export interface OperationCommissionRulePayload {
  unit_name: string;
  member: Pick<OperationTeamMember, 'id' | 'name' | 'username' | 'role' | 'active'>;
  kind: OperationCommissionKind;
  basis: OperationCommissionBasis;
  value: number;
  active: boolean;
  starts_on: string;
  available_bases: OperationCommissionBasis[];
}

export function money(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) / 100 : 0;
}

export function benefitsOf(value: unknown): OperationBenefit[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    const name = String(row.name ?? '').trim().slice(0, 60);
    const amount = money(row.amount);
    if (!name || amount < 0) return [];
    return [{ name, amount, active: row.active !== false }];
  }).slice(0, 12);
}

export function benefitTotal(benefits: OperationBenefit[]): number {
  return money(benefits.reduce((sum, item) => sum + (item.active ? item.amount : 0), 0));
}

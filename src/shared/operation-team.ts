export interface OperationBenefit {
  name: string;
  amount: number;
  active: boolean;
}

export type OperationCommissionKind = 'percent' | 'fixed';
export type OperationCommissionSettlementFrequency = 'weekly' | 'monthly';
export type OperationSalaryPaymentFrequency = 'weekly' | 'monthly';
export type OperationCommissionBasis = 'margin' | 'revenue' | 'sale' | 'delivery' | 'trip';
export type OperationCommissionItemGroup = 'tire' | 'service' | 'other';
export type OperationCommissionItemKind = OperationCommissionKind | 'none';

export interface OperationCommissionItemRule {
  kind: OperationCommissionItemKind;
  value: number;
}

export type OperationCommissionItemRules = Record<OperationCommissionItemGroup, OperationCommissionItemRule>;

export interface OperationTeamMember {
  id: string;
  name: string;
  username: string | null;
  role: string;
  work_area: string;
  active: boolean;
  base_salary: number;
  salary_frequency: OperationSalaryPaymentFrequency;
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
  salary_frequency: OperationSalaryPaymentFrequency;
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
  itemized: boolean;
  item_rules: OperationCommissionItemRules;
  settlement_frequency: OperationCommissionSettlementFrequency;
  available_bases: OperationCommissionBasis[];
  history: OperationCommissionHistoryItem[];
}

export interface OperationCommissionHistoryItem {
  kind: OperationCommissionKind;
  basis: OperationCommissionBasis;
  value: number;
  active: boolean;
  starts_on: string;
  itemized: boolean;
  item_rules: OperationCommissionItemRules;
  settlement_frequency: OperationCommissionSettlementFrequency;
}

export type OperationPermissionKey =
  | 'vendas' | 'estoque' | 'pedidos' | 'clientes' | 'entregas'
  | 'retiradas' | 'batepapo' | 'resumo' | 'financeiro';

export interface OperationPermissionsPayload {
  unit_name: string;
  member: Pick<OperationTeamMember, 'id' | 'name' | 'username' | 'role' | 'active'>;
  permissions: Partial<Record<OperationPermissionKey, boolean>>;
  available_permissions: OperationPermissionKey[];
  locked: boolean;
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

export function emptyCommissionItemRules(): OperationCommissionItemRules {
  return {
    tire: { kind: 'none', value: 0 },
    service: { kind: 'none', value: 0 },
    other: { kind: 'none', value: 0 },
  };
}

export function commissionItemRulesOf(value: unknown): OperationCommissionItemRules {
  const rules = emptyCommissionItemRules();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return rules;
  const source = value as Record<string, unknown>;
  (Object.keys(rules) as OperationCommissionItemGroup[]).forEach((group) => {
    const candidate = source[group];
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return;
    const row = candidate as Record<string, unknown>;
    const rawKind = String(row.kind ?? 'none');
    const kind: OperationCommissionItemKind = rawKind === 'percent'
      ? 'percent' : rawKind === 'fixed' && group === 'tire' ? 'fixed' : 'none';
    const valueAmount = kind === 'none' ? 0 : money(row.value);
    rules[group] = {
      kind: kind === 'percent' && valueAmount > 100 ? 'none' : kind,
      value: kind === 'percent' && valueAmount > 100 ? 0 : valueAmount,
    };
  });
  return rules;
}

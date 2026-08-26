import { benefitsOf, benefitTotal, type OperationBenefit } from '../../shared/operation-team.js';
import { commissionItemRulesOf, type OperationCommissionItemRules } from '../../shared/operation-team.js';

type WorkArea = 'sales' | 'delivery' | 'administrative' | 'workshop' | 'other';
type CommissionBasis = 'margin' | 'revenue' | 'sale' | 'delivery' | 'trip';

export interface CollaboratorManagementRow {
  id: string; display_name: string; username: string; job: string; job_title: string;
  work_area: WorkArea; panel_role: 'owner' | 'admin' | null; active: boolean; last_used_at: string | null;
  allow_vendas: boolean; allow_estoque: boolean; allow_entregas: boolean; allow_financeiro: boolean;
  eligible_in_competence: boolean;
  employment_type: string | null; base_salary: number; monthly_base_salary: number; payment_day: number | null;
  salary_frequency: 'weekly' | 'monthly';
  payment_method: string | null; payment_note: string | null; compensation_starts_on: string | null;
  benefits: OperationBenefit[]; benefits_total: number;
  commission_kind: 'percent' | 'fixed' | null; commission_basis: CommissionBasis | null;
  commission_value: number; commission_starts_on: string | null; commission_active: boolean;
  commission_itemized: boolean; commission_item_rules: OperationCommissionItemRules;
  commission_settlement_frequency: 'weekly' | 'monthly';
  sales_count: number; revenue: number; margin: number; items_without_cost: number; deliveries_count: number;
  trips_count: number; distance_km: number; on_time_pct: number | null;
  additions: number; deductions: number; commission_amount: number; total_due: number;
  payroll_item_id: string | null; payroll_status: 'preview' | 'pending' | 'paid';
  payroll_due_date: string | null; payroll_paid_at: string | null; source_expense_id: string | null;
  payroll_calculation: Record<string, unknown> | null;
}

type QueryResult = { rows: any[] };

function n(value: unknown): number { return Number(value ?? 0); }

export function buildMatrizCollaboratorManagement(input: {
  competence: string;
  people: QueryResult;
  performance: QueryResult;
  adjustments: QueryResult;
  payroll: QueryResult;
  adjustmentDetails: QueryResult;
  assignmentGaps: QueryResult;
  payrollHistory: QueryResult;
}) {
  const { competence, people, performance, adjustments, payroll, adjustmentDetails, assignmentGaps, payrollHistory } = input;
  const perf = new Map(performance.rows.map((r: any) => [r.id, r]));
  const adj = new Map(adjustments.rows.map((r: any) => [r.collaborator_id, r]));
  const frozen = new Map(payroll.rows.map((r: any) => [r.collaborator_id, r]));
  const rows: CollaboratorManagementRow[] = people.rows.map((p: any) => {
    const q = perf.get(p.id) as any ?? {};
    const a = adj.get(p.id) as any ?? {};
    const f = frozen.get(p.id) as any;
    const benefits = benefitsOf(p.benefits);
    const row: CollaboratorManagementRow = {
      ...p, active: Boolean(p.active),
      allow_vendas: Boolean(p.allow_vendas), allow_estoque: Boolean(p.allow_estoque),
      allow_entregas: Boolean(p.allow_entregas), allow_financeiro: Boolean(p.allow_financeiro),
      eligible_in_competence: Boolean(p.eligible_in_competence ?? p.active),
      base_salary: n(p.base_salary), monthly_base_salary: n(p.monthly_base_salary),
      payment_day: p.payment_day === null ? null : n(p.payment_day),
      benefits, benefits_total: benefitTotal(benefits),
      commission_value: n(p.commission_value), commission_active: Boolean(p.commission_active),
      commission_itemized: Boolean(p.commission_itemized),
      commission_item_rules: commissionItemRulesOf(p.commission_item_rules),
      sales_count: n(q.sales_count), revenue: n(q.revenue), margin: n(q.margin),
      items_without_cost: n(q.items_without_cost), deliveries_count: n(q.deliveries_count),
      trips_count: n(q.trips_count), distance_km: n(q.distance_km),
      on_time_pct: q.on_time_pct === null || q.on_time_pct === undefined ? null : n(q.on_time_pct),
      additions: n(a.additions), deductions: n(a.deductions), commission_amount: 0, total_due: 0,
      payroll_item_id: f?.payroll_item_id ?? null, payroll_status: f?.payroll_status ?? 'preview',
      payroll_due_date: f?.payroll_due_date ?? null, payroll_paid_at: f?.payroll_paid_at ?? null,
      source_expense_id: f?.source_expense_id ?? null, payroll_calculation: f?.payroll_calculation ?? null,
    };
    row.commission_amount = f ? n(f.commission_amount) : n(q.commission_amount);
    if (f) Object.assign(row, { base_salary: n(f.base_salary), additions: n(f.additions), deductions: n(f.deductions) });
    row.total_due = f ? n(f.total_due) : Math.max(0, Math.round((row.base_salary + row.benefits_total
      + row.commission_amount + row.additions - row.deductions) * 100) / 100);
    return row;
  });
  const active = rows.filter((r) => r.active);
  const competenceEligible = rows.filter((r) => r.eligible_in_competence);
  const payrollRows = payroll.rows.length ? rows.filter((r) => r.payroll_item_id) : competenceEligible;
  const payable = rows.filter((r) => r.payroll_status === 'pending');
  const paid = rows.filter((r) => r.payroll_status === 'paid');
  const unresolvedAdjustments = adjustmentDetails.rows.filter((r: any) => r.causal_status === 'needs_review').length;
  const unresolvedCosts = competenceEligible.filter((r) => r.items_without_cost > 0
    && r.commission_active && r.commission_kind === 'percent' && r.commission_basis === 'margin'
    && r.commission_settlement_frequency !== 'weekly').length;
  const unassignedEvents = n(assignmentGaps.rows[0]?.missing_count);
  const generatedPayables = rows.filter((r) => r.payroll_item_id && r.source_expense_id);
  const summary = {
    active_count: active.length, role_count: new Set(active.map((r) => r.job_title)).size,
    panel_access_count: active.filter((r) => r.panel_role).length, revoked_count: rows.length - active.length,
    configured_count: competenceEligible.filter((r) => r.employment_type).length,
    base_salary_total: competenceEligible.reduce((s, r) => s + r.base_salary, 0),
    unconfigured_count: competenceEligible.filter((r) => !r.employment_type).length,
    commission_total: competenceEligible.reduce((s, r) => s + r.commission_amount, 0),
    sales_eligible: competenceEligible.reduce((s, r) => s + r.sales_count, 0),
    deliveries_eligible: competenceEligible.reduce((s, r) => s + r.deliveries_count, 0),
    without_rule: competenceEligible.filter((r) => !r.commission_active).length,
    payroll_total: payrollRows.reduce((s, r) => s + r.total_due, 0),
    payroll_payable: payable.reduce((s, r) => s + r.total_due, 0),
    payroll_paid: paid.reduce((s, r) => s + r.total_due, 0), paid_count: paid.length,
    payroll_count: payroll.rows.length || competenceEligible.filter((r) => r.employment_type || r.commission_active).length,
    payroll_period_id: payroll.rows[0]?.payroll_period_id ?? null,
    payroll_period_status: payroll.rows[0]?.payroll_period_status ?? 'preview',
    payroll_generated_count: generatedPayables.length,
    payroll_generated_total: generatedPayables.reduce((s, r) => s + r.total_due, 0),
    payroll_review_count: unresolvedAdjustments + unresolvedCosts + unassignedEvents,
    payroll_review_reasons: {
      unresolved_adjustments: unresolvedAdjustments, unresolved_costs: unresolvedCosts, unassigned_events: unassignedEvents,
    },
    revenue: competenceEligible.reduce((s, r) => s + r.revenue, 0),
    margin: competenceEligible.reduce((s, r) => s + r.margin, 0),
    trips_count: competenceEligible.reduce((s, r) => s + r.trips_count, 0),
  };
  return {
    competence, collaborators: rows, summary,
    adjustments: adjustmentDetails.rows.map((row: any) => ({
      ...row, amount: row.amount === null ? null : n(row.amount),
    })),
    payroll_history: payrollHistory.rows.map((row: any) => ({
      ...row, collaborator_count: n(row.collaborator_count), total: n(row.total),
      pending_count: n(row.pending_count), pending_total: n(row.pending_total),
      paid_count: n(row.paid_count), paid_total: n(row.paid_total),
    })),
  };
}

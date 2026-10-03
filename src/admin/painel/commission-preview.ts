import type { CollaboratorManagementRow } from './queries-colaboradores-payroll-summary.js';
import { commissionTotals, type CommissionFact } from '../caixa/commission-batch.js';

export function applyCommissionPreview(rows: CollaboratorManagementRow[], facts: CommissionFact[]) {
  const totals = commissionTotals(facts);
  for (const row of rows) {
    if (row.payroll_item_id) continue;
    const value = totals.get(row.id);
    row.commission_amount = (value?.amount ?? 0) / 100;
    row.items_without_cost = value?.missingCosts ?? 0;
    if (!row.eligible_in_competence && (row.commission_amount > 0 || row.additions > 0 || row.deductions > 0)) {
      // Late commission remains owed after termination, without inventing a salary.
      row.eligible_in_competence = true;
      row.base_salary = 0;
      row.benefits_total = 0;
    }
    row.total_due = Math.max(0, Math.round((row.base_salary + row.benefits_total
      + row.commission_amount + row.additions - row.deductions) * 100) / 100);
  }
}

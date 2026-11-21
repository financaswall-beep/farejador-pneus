// A categoria operacional pode mudar. Os lançamentos do livro original ficam
// imutáveis e as consultas financeiras mostram a categoria vigente da despesa.
type ExpenseSourceAlias = 't' | 's' | 'b' | 'o';

export function expenseReportCategoryJoinSql(transaction: 't' | 's', ...fallback: ExpenseSourceAlias[]): string {
  const branches = [transaction, ...fallback].map((alias) =>
    `WHEN ${alias}.source_type LIKE 'commerce.matriz_expense.%' THEN ${alias}.source_id`,
  ).join('\n        ');
  return `LEFT JOIN commerce.matriz_expenses category_expense ON category_expense.environment=${transaction}.environment
    AND category_expense.id=CASE WHEN (CASE ${branches} END) ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
      THEN (CASE ${branches} END)::uuid END`;
}

export const expenseReportAccountSql = `CASE
  WHEN category_expense.category IS NOT NULL AND e.account_class='expense' AND left(e.account_code,8)='expense_'
  THEN 'expense_'||category_expense.category ELSE e.account_code END`;

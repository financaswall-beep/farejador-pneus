import { moneyCents } from './stage5-integrity.js';

export interface GroupPurchaseMoney {
  status: string;
  total_amount: string;
  freight_amount: string;
  items_count: number;
  stock_applied: boolean;
}
export interface GroupExpenseMoney {
  amount: string;
  category: string;
  deleted_at: string | null;
}

/** Mesmas colunas das listas de Compras/Despesas. Nunca lê ou escreve livro. */
export function purchaseGroupSummary(purchases: GroupPurchaseMoney[], expenses: GroupExpenseMoney[]) {
  const active = purchases.filter(p => p.status !== 'cancelled');
  const live = expenses.filter(e => !e.deleted_at);
  const purchaseCents = active.reduce((sum, p) => sum + moneyCents(Number(p.total_amount)), 0);
  const expenseCents = live.reduce((sum, e) => sum + moneyCents(Number(e.amount)), 0);
  const freightCents = active.reduce((sum, p) => sum + moneyCents(Number(p.freight_amount)), 0);
  const tires = active.reduce((sum, p) => sum + Number(p.items_count), 0);
  const received = active.filter(p => p.stock_applied).reduce((sum, p) => sum + Number(p.items_count), 0);
  const pending = active.filter(p => !p.stock_applied).length;
  const total = purchaseCents + expenseCents;
  return { purchases: (purchaseCents / 100).toFixed(2), freight_included: (freightCents / 100).toFixed(2),
    expenses: (expenseCents / 100).toFixed(2), total: (total / 100).toFixed(2),
    tires, received, transit: tires - received, pending_purchases: pending, provisional: pending > 0,
    cost_per_tire: tires > 0 ? (Math.round(total / tires) / 100).toFixed(2) : null,
    freight_warning: freightCents > 0 && live.some(e => e.category === 'frete') };
}

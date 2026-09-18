import type { PurchaseReportPeriod } from './queries-compras-relatorios.js';

export function periodClause(period: PurchaseReportPeriod, column: string): string | null {
  const local = `(${column} AT TIME ZONE 'America/Sao_Paulo')`;
  if (period === '30d') return `${local} >= (now() AT TIME ZONE 'America/Sao_Paulo') - interval '30 days'`;
  if (period === '90d') return `${local} >= (now() AT TIME ZONE 'America/Sao_Paulo') - interval '90 days'`;
  if (period === 'year') {
    return `${local} >= date_trunc('year', now() AT TIME ZONE 'America/Sao_Paulo')`;
  }
  return null;
}

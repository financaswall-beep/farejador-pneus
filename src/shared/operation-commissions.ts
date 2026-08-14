import { simpleFinanceRangeDays, type SimpleFinanceRange } from './simple-finance.js';

export type OperationCommissionStatus = 'open' | 'payable' | 'paid';

export interface OperationCommissionSale {
  id: string;
  reference: string;
  occurred_at: string;
  payment_method: string | null;
  gross_amount: number;
  commission_amount: number;
}

export interface OperationCommissionCollaborator {
  id: string;
  name: string;
  username: string | null;
  role: string;
  active: boolean;
  sales_count: number;
  gross_sales: number;
  commission_kind: 'percent' | 'fixed' | null;
  commission_basis: string | null;
  commission_value: number;
  commission_amount: number;
  status: OperationCommissionStatus;
  payment_target_id: string | null;
  payment_total: number | null;
}

export interface OperationCommissionsPayload {
  range: SimpleFinanceRange;
  unit_name: string;
  total_commission: number;
  total_sales: number;
  average_commission: number;
  collaborators: OperationCommissionCollaborator[];
}

export interface OperationCommissionDetailPayload {
  range: SimpleFinanceRange;
  unit_name: string;
  collaborator: OperationCommissionCollaborator;
  sales: OperationCommissionSale[];
}

function saoPauloToday(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function shiftIsoDate(value: string, days: number): string {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

export function operationCommissionBounds(range: SimpleFinanceRange): {
  start: string; end: string; competence: string;
} {
  const today = saoPauloToday();
  const competence = `${today.slice(0, 7)}-01`;
  return {
    // O recorte mensal acompanha a competência da folha. Os demais atalhos
    // continuam sendo janelas móveis para consulta operacional.
    start: range === '30d'
      ? competence
      : shiftIsoDate(today, -(simpleFinanceRangeDays(range) - 1)),
    end: shiftIsoDate(today, 1),
    competence,
  };
}

export function money(value: unknown): number {
  return Math.round(Number(value ?? 0) * 100) / 100;
}

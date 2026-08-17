import type { PoolClient } from 'pg';
import { moneyCents } from './stage5-integrity.js';

export type MatrizLedgerAccountClass =
  | 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export interface MatrizLedgerLine {
  account_code: string;
  account_class: MatrizLedgerAccountClass;
  side: 'debit' | 'credit';
  amount: number;
}

export interface MatrizLedgerPaymentDetails {
  payment_method?: string | null;
  cash_account?: string | null;
  note?: string | null;
}

export interface MatrizLedgerPostInput {
  environment: 'prod' | 'test';
  sourceType: string;
  sourceId: string;
  kind: string;
  amount: number;
  occurredAt: string;
  dueDate?: string | null;
  cashAt?: string | null;
  description: string;
  createdBy: string;
  lines: MatrizLedgerLine[];
  metadata: Record<string, unknown>;
}

export function matrizLedgerActor(value?: string | null): string {
  const normalized = value?.trim();
  return normalized && normalized.length >= 2 ? normalized : 'system:matriz-ledger';
}

export function matrizLedgerAmount(value: string | number, errorCode: string): number {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw new Error(errorCode);
  try {
    return moneyCents(amount) / 100;
  } catch {
    throw new Error(errorCode);
  }
}

export async function postMatrizLedgerTransaction(
  client: PoolClient,
  input: MatrizLedgerPostInput,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `SELECT finance.post_matriz_ledger_transaction(
       $1::env_t,$2,$3,$4,$5,
       ($6::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date,
       $7,$8,$9::jsonb,$10::date,
       CASE WHEN $11::timestamptz IS NULL THEN NULL
         ELSE ($11::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date END,
       $12::jsonb
     ) id`,
    [
      input.environment, input.sourceType, input.sourceId, input.kind, input.amount,
      input.occurredAt, input.description, input.createdBy, JSON.stringify(input.lines),
      input.dueDate ?? null, input.cashAt ?? null, JSON.stringify(input.metadata),
    ],
  );
  return result.rows[0]!.id;
}

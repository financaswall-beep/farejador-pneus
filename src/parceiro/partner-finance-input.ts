import type { PoolClient } from 'pg';
import type { PartnerContext } from './auth.js';
import type { RegisterPartnerSaleInput } from './queries.js';
import { moneyCents } from '../shared/catalog-pricing.js';
import { partnerSaleTotalCents } from './partner-sale-pricing.js';

export function normalizePartnerText(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

export function normalizePartnerCpf(value: string | null | undefined): string | null {
  const digits = value?.replace(/\D/g, '') ?? '';
  return digits.length === 11 ? digits : null;
}

export function assertPositiveCentMoney(
  value: number, code = 'partner_finance_amount_invalid',
): number {
  const cents = moneyCents(value);
  if (!Number.isFinite(value) || cents <= 0
      || Math.abs(value * 100 - cents) >= 1e-7) throw new Error(code);
  return cents / 100;
}

export function validatePartnerSaleFinancialInput(input: RegisterPartnerSaleInput): void {
  if (input.fulfillment_mode === 'delivery' && input.payment_status !== 'receivable') {
    throw new Error('partner_delivery_must_be_cash_on_delivery');
  }
  if (input.payment_status === 'receivable'
      && input.fulfillment_mode !== 'delivery' && !input.receivable_due_date) {
    throw new Error('receivable_due_date_required');
  }
  if (input.payment_status !== 'receivable' && !normalizePartnerText(input.payment_method)) {
    throw new Error('payment_method_required');
  }
  const totalCents = partnerSaleTotalCents(
    input.items, input.discount_amount ?? 0, input.freight_amount ?? 0,
  );
  if (input.payment_status !== 'receivable' && input.received_amount != null
      && moneyCents(input.received_amount) < totalCents) {
    throw new Error('received_amount_below_sale_total');
  }
}

export async function lockPartnerSaleIdempotency(
  client: Pick<PoolClient, 'query'>, ctx: PartnerContext, idempotencyKey: string,
): Promise<void> {
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtext($1))',
    [`partner-sale:${ctx.environment}:${ctx.unitId}:${idempotencyKey}`],
  );
}

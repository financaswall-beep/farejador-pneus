export const RECEIPT_REVIEW_POLICY = Object.freeze({
  max_amount: 10_000,
  retroactive_months: 3,
  amount_attention_ratio: 0.2,
});

export interface ReceiptApprovalInput {
  amount: number;
  suggested_amount?: number | null;
  category: string;
  merchant?: string | null;
  document_date: string;
  competence_month: string;
  payment_status: 'paid' | 'pending';
  payment_date?: string | null;
  due_date?: string | null;
  retroactive_confirmed?: boolean;
  competence_confirmed?: boolean;
  possible_duplicate_confirmed?: boolean;
}

export interface ReceiptApprovalResult extends ReceiptApprovalInput {
  amount_cents: number;
  amount_attention: boolean;
  occurred_at: string;
  payment_at: string | null;
  merchant: string | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(value: string, code: string): void {
  if (!DATE_RE.test(value)) throw new Error(code);
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  if (parsed.getUTCFullYear() !== year
      || parsed.getUTCMonth() !== month! - 1
      || parsed.getUTCDate() !== day) throw new Error(code);
}

function addMonths(month: string, delta: number): string {
  const [year, monthNumber] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year!, monthNumber! - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

function saoPauloMidnight(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const noonUtc = Date.UTC(year!, month! - 1, day!, 12);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(noonUtc))
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, Number(part.value)])) as Record<string, number>;
  const localNoonAsUtc = Date.UTC(
    parts.year!, parts.month! - 1, parts.day!,
    parts.hour!, parts.minute!, parts.second!,
  );
  const offset = localNoonAsUtc - noonUtc;
  return new Date(Date.UTC(year!, month! - 1, day!) - offset).toISOString();
}

export function receiptAmountNeedsAttention(
  approvedAmount: number,
  suggestedAmount?: number | null,
): boolean {
  if (!Number.isFinite(suggestedAmount) || Number(suggestedAmount) <= 0) return false;
  return Math.abs(approvedAmount - Number(suggestedAmount)) / Number(suggestedAmount)
    > RECEIPT_REVIEW_POLICY.amount_attention_ratio;
}

export function normalizeReceiptApproval(
  input: ReceiptApprovalInput,
  options: { today: string; max_amount?: number },
): ReceiptApprovalResult {
  assertDate(options.today, 'receipt_document_date_future');
  assertDate(input.document_date, 'receipt_document_date_future');
  if (input.document_date > options.today) throw new Error('receipt_document_date_future');

  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new Error('receipt_amount_invalid');
  }
  const amountCents = Math.round(input.amount * 100);
  if (Math.abs(amountCents / 100 - input.amount) > 1e-9) {
    throw new Error('receipt_amount_invalid');
  }
  const maxAmount = options.max_amount ?? RECEIPT_REVIEW_POLICY.max_amount;
  if (!Number.isFinite(maxAmount) || maxAmount <= 0
      || amountCents > Math.round(maxAmount * 100)) {
    throw new Error('receipt_amount_above_limit');
  }

  assertDate(input.competence_month, 'receipt_competence_confirmation_required');
  if (!input.competence_month.endsWith('-01')) {
    throw new Error('receipt_competence_confirmation_required');
  }
  const documentMonth = `${input.document_date.slice(0, 7)}-01`;
  if (input.competence_month !== documentMonth && !input.competence_confirmed) {
    throw new Error('receipt_competence_confirmation_required');
  }
  const currentMonth = `${options.today.slice(0, 7)}-01`;
  if (input.competence_month > currentMonth) throw new Error('receipt_competence_future');
  const retroactiveCutoff = addMonths(currentMonth, -RECEIPT_REVIEW_POLICY.retroactive_months);
  if (input.competence_month < retroactiveCutoff && !input.retroactive_confirmed) {
    throw new Error('receipt_retroactive_confirmation_required');
  }

  let paymentAt: string | null = null;
  if (input.payment_status === 'paid') {
    if (!input.payment_date) throw new Error('receipt_payment_date_required');
    assertDate(input.payment_date, 'receipt_payment_date_required');
    if (input.payment_date > options.today) throw new Error('receipt_payment_date_future');
    paymentAt = saoPauloMidnight(input.payment_date);
  } else {
    if (!input.due_date) throw new Error('receipt_due_date_required');
    assertDate(input.due_date, 'receipt_due_date_required');
  }

  return {
    ...input,
    amount_cents: amountCents,
    amount_attention: receiptAmountNeedsAttention(input.amount, input.suggested_amount),
    occurred_at: saoPauloMidnight(input.document_date),
    payment_at: paymentAt,
    merchant: input.merchant?.trim() || null,
  };
}

export function validateReceiptRejection(reason: string): { reason: string } {
  const normalized = reason.trim();
  if (normalized.length < 2) throw new Error('reason_required');
  return { reason: normalized };
}

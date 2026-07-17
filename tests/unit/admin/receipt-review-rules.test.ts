import { describe, expect, it } from 'vitest';
import {
  RECEIPT_REVIEW_POLICY,
  normalizeReceiptApproval,
  receiptAmountNeedsAttention,
  validateReceiptRejection,
} from '../../../src/admin/painel/receipt-review.js';

const baseApproval = {
  amount: 187.3,
  suggested_amount: 187.3,
  category: 'combustivel',
  document_date: '2026-07-10',
  competence_month: '2026-07-01',
  payment_status: 'paid' as const,
  payment_date: '2026-07-10',
  due_date: null,
  retroactive_confirmed: false,
  competence_confirmed: false,
};

describe('Etapa 7 — regras puras da revisao humana', () => {
  it('centraliza os tres numeros de politica decididos pelo dono', () => {
    expect(RECEIPT_REVIEW_POLICY).toEqual({
      max_amount: 10_000,
      retroactive_months: 3,
      amount_attention_ratio: 0.2,
    });
  });

  it('normaliza centavos e deriva occurred_at no fuso de Sao Paulo', () => {
    expect(normalizeReceiptApproval(baseApproval, { today: '2026-07-17' }))
      .toMatchObject({
        amount_cents: 18_730,
        document_date: '2026-07-10',
        competence_month: '2026-07-01',
        occurred_at: '2026-07-10T03:00:00.000Z',
        payment_status: 'paid',
      });
  });

  it('recusa data futura e valor fora do cinto', () => {
    expect(() => normalizeReceiptApproval(
      { ...baseApproval, document_date: '2026-07-18' },
      { today: '2026-07-17' },
    )).toThrow('receipt_document_date_future');
    expect(() => normalizeReceiptApproval(
      { ...baseApproval, amount: 10_000.01 },
      { today: '2026-07-17' },
    )).toThrow('receipt_amount_above_limit');
    expect(() => normalizeReceiptApproval(
      { ...baseApproval, amount: 10.001 },
      { today: '2026-07-17' },
    )).toThrow('receipt_amount_invalid');
    expect(() => normalizeReceiptApproval(
      { ...baseApproval, payment_date: '2026-07-18' },
      { today: '2026-07-17' },
    )).toThrow('receipt_payment_date_future');
    expect(() => normalizeReceiptApproval(
      { ...baseApproval, competence_month: '2026-08-01', competence_confirmed: true },
      { today: '2026-07-17' },
    )).toThrow('receipt_competence_future');
  });

  it('exige confirmacao para retroativo e competencia divergente', () => {
    expect(() => normalizeReceiptApproval({
      ...baseApproval,
      document_date: '2026-03-31',
      competence_month: '2026-03-01',
    }, { today: '2026-07-17' })).toThrow('receipt_retroactive_confirmation_required');

    expect(() => normalizeReceiptApproval({
      ...baseApproval,
      competence_month: '2026-06-01',
    }, { today: '2026-07-17' })).toThrow('receipt_competence_confirmation_required');
  });

  it('exige a data coerente com pago ou pendente', () => {
    expect(() => normalizeReceiptApproval(
      { ...baseApproval, payment_date: null },
      { today: '2026-07-17' },
    )).toThrow('receipt_payment_date_required');
    expect(() => normalizeReceiptApproval({
      ...baseApproval,
      payment_status: 'pending',
      payment_date: null,
      due_date: null,
    }, { today: '2026-07-17' })).toThrow('receipt_due_date_required');
  });

  it('destaca diferenca acima de vinte por cento sem bloquear', () => {
    expect(receiptAmountNeedsAttention(100, 80)).toBe(true);
    expect(receiptAmountNeedsAttention(100, 85)).toBe(false);
    expect(normalizeReceiptApproval({
      ...baseApproval,
      amount: 100,
      suggested_amount: 80,
    }, { today: '2026-07-17' })).toMatchObject({ amount_attention: true });
  });

  it('rejeicao e terminal e exige motivo util', () => {
    expect(() => validateReceiptRejection(' ')).toThrow('reason_required');
    expect(validateReceiptRejection('Cupom de outra compra'))
      .toEqual({ reason: 'Cupom de outra compra' });
  });
});

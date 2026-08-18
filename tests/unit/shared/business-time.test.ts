import { describe, expect, it } from 'vitest';
import {
  assertNotFutureBusinessDay,
  businessDateSaoPaulo,
  isNotFutureBusinessDate,
  normalizeBusinessFactInstant,
} from '../../../src/shared/business-time.js';

describe('dia comercial único do sistema', () => {
  const midnight = new Date('2026-08-18T03:06:29.919Z');

  it('interpreta o calendário em São Paulo', () => {
    expect(businessDateSaoPaulo(midnight)).toBe('2026-08-18');
    expect(isNotFutureBusinessDate('2026-08-18T15:00:00.000Z', midnight)).toBe(true);
    expect(isNotFutureBusinessDate('2026-08-19T03:00:00.000Z', midnight)).toBe(false);
    expect(isNotFutureBusinessDate('data-invalida', midnight)).toBe(false);
  });

  it('troca o meio-dia futuro de hoje pelo instante real', () => {
    expect(normalizeBusinessFactInstant('2026-08-18T15:00:00.000Z', midnight))
      .toBe(midnight.toISOString());
  });

  it('recusa fatos de amanhã sem recusar vencimentos em outro campo', () => {
    expect(() => normalizeBusinessFactInstant(
      '2026-08-19T15:00:00.000Z', midnight, 'paid_at_future',
    )).toThrow('paid_at_future');
    expect(() => assertNotFutureBusinessDay(
      '2026-08-19', midnight, 'document_date_future',
    )).toThrow('document_date_future');
    expect(assertNotFutureBusinessDay('2026-08-18', midnight)).toBe('2026-08-18');
  });
});

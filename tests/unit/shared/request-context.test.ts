import { describe, expect, it } from 'vitest';
import {
  createRequestId,
  normalizeRequestIdHeader,
  requestContext,
} from '../../../src/shared/request-context.js';

describe('request context', () => {
  it('aceita correlation id externo somente no formato seguro', () => {
    expect(normalizeRequestIdHeader('checkout-7f5b4a01')).toBe('checkout-7f5b4a01');
    expect(normalizeRequestIdHeader(['trace-a'])).toBe('trace-a');
    expect(normalizeRequestIdHeader(' com espaco ')).toBeUndefined();
    expect(normalizeRequestIdHeader('x'.repeat(129))).toBeUndefined();
    expect(normalizeRequestIdHeader(['a', 'b'])).toBeUndefined();
  });

  it('preserva id valido recebido e gera UUID quando ausente ou invalido', () => {
    expect(createRequestId({ headers: { 'x-request-id': 'client-abc_123' } })).toBe('client-abc_123');
    expect(createRequestId({ headers: { 'x-request-id': '<script>' } })).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(createRequestId({ headers: {} })).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('mantem o request id no contexto assincrono', async () => {
    await requestContext.run({ requestId: 'req-stage11' }, async () => {
      await Promise.resolve();
      expect(requestContext.getStore()?.requestId).toBe('req-stage11');
    });
    expect(requestContext.getStore()).toBeUndefined();
  });
});

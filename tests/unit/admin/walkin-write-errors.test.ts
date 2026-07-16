import { beforeAll, describe, expect, it } from 'vitest';

let mapWriteError: typeof import('../../../src/admin/painel/route-helpers.js').mapWriteError;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    FAREJADOR_ENV: 'test',
    DATABASE_URL: 'postgres://test',
    CHATWOOT_HMAC_SECRET: 'test-secret',
    ADMIN_AUTH_TOKEN: 'emergency-token',
  });
  ({ mapWriteError } = await import('../../../src/admin/painel/route-helpers.js'));
});

describe('erros publicos da venda walk-in atomica', () => {
  it.each([
    'walkin_measure_not_found',
    'walkin_cost_missing',
    'walkin_stock_insufficient',
    'walkin_stock_ambiguous',
    'walkin_idempotency_conflict',
  ])('mapeia conflito comercial %s para 409', (message) => {
    expect(mapWriteError(new Error(message))).toEqual({ status: 409, error: message });
  });

  it.each([
    'walkin_items_required',
    'walkin_idempotency_required',
    'walkin_item_invalid',
    'walkin_total_invalid',
    'walkin_unit_not_found',
  ])('mapeia entrada invalida %s para 400', (message) => {
    expect(mapWriteError(new Error(message))).toEqual({ status: 400, error: message });
  });

  it('nao expoe falha interna do fechamento', () => {
    expect(mapWriteError(new Error('walkin_order_not_confirmed')))
      .toEqual({ status: 500, error: 'internal_server_error' });
  });
});

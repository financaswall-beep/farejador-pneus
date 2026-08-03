import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PartnerContext } from '../../../src/parceiro/auth.js';

const mocks = vi.hoisted(() => ({
  partnerQuery: vi.fn(),
  adminQuery: vi.fn(),
}));

vi.mock('../../../src/parceiro/db.js', () => ({
  withPartnerContext: async (_partnerUnitId: string, callback: (client: { query: typeof mocks.partnerQuery }) => Promise<unknown>) => (
    callback({ query: mocks.partnerQuery })
  ),
}));

vi.mock('../../../src/persistence/db.js', () => ({
  pool: { query: mocks.adminQuery, connect: vi.fn() },
}));

vi.mock('../../../src/parceiro/auth.js', () => ({
  PARTNER_SCREENS: ['vendas', 'estoque', 'pedidos', 'clientes', 'entregas', 'retiradas', 'batepapo', 'resumo', 'financeiro'],
  resolvePartnerPermissions: vi.fn(),
}));

vi.mock('../../../src/shared/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock('../../../src/admin/chatwoot-api.client.js', () => ({
  ChatwootApiClient: class {},
}));

import {
  registerPartnerReceivable,
  updatePartnerReceivable,
} from '../../../src/parceiro/queries.js';
import { isReceivableCustomerScopeError } from '../../../src/parceiro/receivable-customer-scope.js';

const ctx: PartnerContext = {
  environment: 'test',
  partnerId: 'partner-a',
  partnerUnitId: 'partner-unit-a',
  unitId: 'unit-a',
  slug: 'loja-a',
  partnerName: 'Parceiro A',
  unitName: 'Unidade A',
  role: 'owner',
  tokenId: 'token-a',
};

beforeEach(() => {
  mocks.partnerQuery.mockReset();
  mocks.adminQuery.mockReset();
});

describe('customer_id de contas a receber', () => {
  it('reconhece somente os erros de escopo que devem virar 404 uniforme', () => {
    expect(isReceivableCustomerScopeError(new Error('customer_not_found'))).toBe(true);
    expect(isReceivableCustomerScopeError({
      code: '23514', message: 'partner_receivable_customer_scope_mismatch',
    })).toBe(true);
    expect(isReceivableCustomerScopeError({ code: '23514', message: 'outro_check' })).toBe(false);
  });

  it('bloqueia o create antes de escrever quando o cliente nao pertence ao escopo', async () => {
    mocks.partnerQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(registerPartnerReceivable(ctx, {
      customer_id: '11111111-1111-4111-8111-111111111111',
      customer_name: 'Cliente externo',
      description: 'Conta indevida',
      amount: 100,
      due_date: '2026-08-15',
      status: 'open',
    })).rejects.toThrow('customer_not_found');

    expect(mocks.partnerQuery).toHaveBeenCalledTimes(1);
    expect(String(mocks.partnerQuery.mock.calls[0]?.[0])).toContain('AND environment = $2');
    expect(String(mocks.partnerQuery.mock.calls[0]?.[0])).toContain('AND unit_id = $3');
    expect(mocks.partnerQuery.mock.calls[0]?.[1]).toEqual([
      '11111111-1111-4111-8111-111111111111', 'test', 'unit-a',
    ]);
  });

  it('bloqueia o update antes de tocar na conta quando o cliente nao pertence ao escopo', async () => {
    mocks.partnerQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(updatePartnerReceivable(ctx, '22222222-2222-4222-8222-222222222222', {
      customer_id: '33333333-3333-4333-8333-333333333333',
      customer_name: 'Cliente externo',
      description: 'Conta indevida',
      amount: 100,
      due_date: '2026-08-15',
    })).rejects.toThrow('customer_not_found');

    expect(mocks.partnerQuery).toHaveBeenCalledTimes(1);
  });

  it('preserva conta avulsa quando customer_id e null', async () => {
    mocks.partnerQuery
      .mockResolvedValueOnce({ rows: [{ id: 'receivable-a' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await expect(registerPartnerReceivable(ctx, {
      customer_id: null,
      customer_name: 'Cliente avulso',
      description: 'Conta valida',
      amount: 50,
      due_date: '2026-08-16',
      status: 'open',
    })).resolves.toEqual({ receivable_id: 'receivable-a' });

    expect(mocks.partnerQuery).toHaveBeenCalledTimes(2);
    expect(String(mocks.partnerQuery.mock.calls[0]?.[0])).toContain('INSERT INTO finance.partner_receivables');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PartnerContext } from '../../../src/parceiro/auth.js';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
}));

vi.mock('../../../src/persistence/db.js', () => ({
  pool: {
    query: mocks.query,
    connect: vi.fn(async () => ({ query: mocks.clientQuery, release: mocks.release })),
  },
}));

import {
  approveOperationRegistration,
  approveOperationStockCount,
  getPendingOperationStockRequests,
  OperationStockReviewError,
  rejectOperationStockRequest,
} from '../../../src/parceiro/operation-stock-owner.js';

const ctx: PartnerContext = {
  environment: 'test', partnerId: 'partner-a', partnerUnitId: 'partner-unit-a',
  unitId: 'unit-a', slug: 'loja-a', partnerName: 'Parceiro A',
  unitName: 'Unidade A', role: 'owner', tokenId: 'owner-token',
};

beforeEach(() => {
  mocks.query.mockReset();
  mocks.clientQuery.mockReset();
  mocks.release.mockReset();
});

describe('aprovação de estoque pelo dono', () => {
  it('lista somente pendências da unidade autenticada', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: 'registration-a' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'count-a' }] });

    await expect(getPendingOperationStockRequests(ctx)).resolves.toMatchObject({
      pending_total: 2,
      registrations: [{ id: 'registration-a' }],
      counts: [{ id: 'count-a' }],
    });
    for (const call of mocks.query.mock.calls) {
      expect(String(call[0])).toContain('environment=$1');
      expect(String(call[0])).toContain('unit_id=$2');
      expect(call[1]).toEqual(['test', 'unit-a']);
    }
  });

  it('aprova cadastro em uma transação, cria estoque e grava auditoria', async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{
        id: 'request-a', item_type: 'pneu', local_sku: 'SKU-1',
        item_name: 'Maggion 90/90-18', tire_size: '90/90-18',
        tire_width_mm: 90, tire_aspect_ratio: 90, tire_rim_diameter: 18,
        brand: 'Maggion', minimum_quantity: 2, tire_condition: 'novo',
        shelf_location: 'A1', tire_position: 'Dianteiro', status: 'pending',
      }] })
      .mockResolvedValueOnce({ rows: [{ id: 'product-a' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'stock-a' }] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({}); // COMMIT

    await expect(approveOperationRegistration(ctx, 'Dono', 'request-a', {
      average_cost: 120, sale_price: 199.9, quantity_on_hand: 8,
      minimum_quantity: 2, supplier_name: 'Fornecedor A',
    })).resolves.toEqual({ id: 'request-a', stock_id: 'stock-a', status: 'approved' });

    const sql = mocks.clientQuery.mock.calls.map((call) => String(call[0])).join('\n');
    expect(sql).toContain('INSERT INTO commerce.partner_stock_levels');
    expect(sql).toContain('commerce.catalog_measure_identity');
    expect(sql).toContain("SET status='approved'");
    const insertCall = mocks.clientQuery.mock.calls.find((call) =>
      String(call[0]).includes('INSERT INTO commerce.partner_stock_levels'));
    expect(insertCall?.[1]?.[20]).toBe('product-a');
    const auditCall = mocks.clientQuery.mock.calls.find((call) =>
      String(call[0]).includes('INSERT INTO audit.events'));
    expect(auditCall?.[1]).toContain('partner_item_registration_approved');
    expect(sql).toContain('COMMIT');
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('recusa contagem antiga e desfaz a transação sem mexer no saldo', async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{
        status: 'pending', stock_id: 'stock-a', item_name: 'Pneu A',
        quantity_snapshot: 12, counted_quantity: 11, current_quantity: 10,
        quantity_reserved: 0, is_stale: true,
      }] })
      .mockResolvedValueOnce({});

    await expect(approveOperationStockCount(ctx, 'Dono', 'count-a'))
      .rejects.toMatchObject<Partial<OperationStockReviewError>>({
        code: 'stock_count_stale', status: 409,
      });

    const sql = mocks.clientQuery.mock.calls.map((call) => String(call[0])).join('\n');
    expect(sql).toContain('ROLLBACK');
    expect(sql).not.toContain('UPDATE commerce.partner_stock_levels');
  });

  it('aprova contagem atual, recalcula status e audita na mesma transação', async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{
        status: 'pending', stock_id: 'stock-a', item_name: 'Pneu A',
        quantity_snapshot: 12, counted_quantity: 11, current_quantity: 12,
        quantity_reserved: 2, is_stale: false,
      }] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    await expect(approveOperationStockCount(ctx, 'Dono', 'count-a')).resolves.toEqual({
      id: 'count-a', stock_id: 'stock-a', status: 'approved',
    });
    const sql = mocks.clientQuery.mock.calls.map((call) => String(call[0])).join('\n');
    expect(sql).toContain('UPDATE commerce.partner_stock_levels');
    expect(sql).toContain('commerce.partner_stock_status');
    expect(mocks.clientQuery.mock.calls[4]?.[1]).toContain('partner_stock_count_approved');
    expect(sql).toContain('COMMIT');
  });

  it('não aceita contagem menor que a quantidade já reservada', async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{
        status: 'pending', stock_id: 'stock-a', item_name: 'Pneu A',
        quantity_snapshot: 5, counted_quantity: 1, current_quantity: 5,
        quantity_reserved: 2, is_stale: false,
      }] })
      .mockResolvedValueOnce({});

    await expect(approveOperationStockCount(ctx, 'Dono', 'count-a'))
      .rejects.toMatchObject({ code: 'stock_count_below_reserved', status: 409 });
    expect(mocks.clientQuery.mock.calls.map((call) => String(call[0])).join('\n'))
      .not.toContain('UPDATE commerce.partner_stock_levels');
  });

  it('rejeita solicitação pendente sem atualizar o estoque oficial', async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: 'count-a' }] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    await expect(rejectOperationStockRequest(ctx, 'Dono', 'contagem', 'count-a', 'Recontar item'))
      .resolves.toEqual({ id: 'count-a', status: 'rejected' });
    const sql = mocks.clientQuery.mock.calls.map((call) => String(call[0])).join('\n');
    expect(sql).toContain("SET status='rejected'");
    expect(sql).not.toContain('UPDATE commerce.partner_stock_levels');
  });
});

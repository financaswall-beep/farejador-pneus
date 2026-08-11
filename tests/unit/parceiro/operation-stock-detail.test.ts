import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PartnerContext } from '../../../src/parceiro/auth.js';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../../src/persistence/db.js', () => ({ pool: { query: mocks.query } }));

import {
  getOperationStockDetail,
  normalizeOperationStockMovement,
} from '../../../src/parceiro/operation-stock-detail.js';

const stockId = 'a506b526-4c48-4cc0-b086-2acc045aa885';
const ctx: PartnerContext = {
  environment: 'test', partnerId: 'partner-a', partnerUnitId: 'partner-unit-a',
  unitId: 'unit-a', slug: 'loja-a', partnerName: 'Parceiro A', unitName: 'Unidade A',
  role: 'employee', tokenId: 'employee-token',
};

beforeEach(() => mocks.query.mockReset());

function event(eventType: string, payload: Record<string, unknown>) {
  return {
    id: 'event-1', entity_id: null, event_type: eventType,
    actor_label: 'Caixa: Wallace (wallace311)', payload_after: payload,
    created_at: '2026-08-11T10:42:00.000Z',
  };
}

describe('histórico operacional de um item do estoque', () => {
  it('isola a baixa da venda referente ao produto aberto', () => {
    const movement = normalizeOperationStockMovement(event('stock_decrement_sale', {
      order_id: 'order-1048',
      moves: [
        { stock_id: 'outro-estoque', delta: -4 },
        { stock_id: stockId, delta: -1 },
      ],
    }), stockId);

    expect(movement).toMatchObject({
      kind: 'sale', reference_id: 'order-1048', quantity_delta: -1,
      actor_label: 'Caixa: Wallace (wallace311)',
    });
  });

  it('alinha o item recebido com a movimentação da mesma posição', () => {
    const movement = normalizeOperationStockMovement(event('stock_increment_purchase', {
      purchase_id: 'purchase-0284',
      moves: [{ stock_id: stockId, new_qty: 12 }],
      items: [{ quantity: 5 }],
    }), stockId);

    expect(movement).toMatchObject({
      kind: 'purchase', reference_id: 'purchase-0284', quantity_delta: 5,
    });
  });

  it('calcula somente a diferença aprovada na contagem', () => {
    const movement = normalizeOperationStockMovement(event('partner_stock_count_approved', {
      request_id: 'count-a008', stock_id: stockId,
      quantity_before: 1, quantity_after: 3,
    }), stockId);

    expect(movement).toMatchObject({
      kind: 'count', reference_id: 'count-a008', quantity_delta: 2,
    });
  });

  it('não transforma valor ausente em movimentação de zero unidades', () => {
    const movement = normalizeOperationStockMovement(event('stock_item_created', {
      stock_id: stockId, quantity_on_hand: null,
    }), stockId);

    expect(movement).toMatchObject({ kind: 'registration', quantity_delta: null });
  });

  it('busca produto somente dentro da unidade autenticada e não devolve o evento bruto', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ stock_id: stockId, item_name: '90/90-18', sale_price: '199.90' }] })
      .mockResolvedValueOnce({ rows: [event('stock_decrement_sale', {
        order_id: 'order-1048', moves: [{ stock_id: stockId, delta: -1 }],
      })] })
      .mockResolvedValueOnce({ rows: [{ total: 1 }] });

    await expect(getOperationStockDetail(ctx, stockId, 1, 20)).resolves.toMatchObject({
      stock: { stock_id: stockId, sale_price: '199.90' },
      history: { total: 1, has_more: false, rows: [{ kind: 'sale', quantity_delta: -1 }] },
    });
    expect(String(mocks.query.mock.calls[0]?.[0])).toContain('unit_id=$3');
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([stockId, 'test', 'unit-a']);
    expect(String(mocks.query.mock.calls[1]?.[0])).not.toContain('SELECT e.*');
  });
});

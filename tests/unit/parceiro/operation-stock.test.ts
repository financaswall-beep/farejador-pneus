import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PartnerContext } from '../../../src/parceiro/auth.js';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('../../../src/parceiro/db.js', () => ({
  withPartnerContext: async (_partnerUnitId: string, callback: (client: { query: typeof mocks.query }) => Promise<unknown>) => (
    callback({ query: mocks.query })
  ),
}));

import {
  getOperationStock,
  requestOperationItemRegistration,
  requestOperationStockCount,
} from '../../../src/parceiro/operation-stock.js';
import {
  attachOperationStockCountEvidence,
  requestOperationStockCountBatch,
} from '../../../src/parceiro/operation-stock-count.js';

const ctx: PartnerContext = {
  environment: 'test',
  partnerId: 'partner-a',
  partnerUnitId: 'partner-unit-a',
  unitId: 'unit-a',
  slug: 'loja-a',
  partnerName: 'Parceiro A',
  unitName: 'Unidade A',
  role: 'funcionario',
  tokenId: 'token-a',
};

beforeEach(() => mocks.query.mockReset());

describe('operações seguras de estoque do funcionário', () => {
  it('consulta somente campos operacionais e mantém o escopo da unidade', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ stock_id: 'stock-a', item_name: 'Pneu A' }] })
      .mockResolvedValueOnce({ rows: [{ item_registrations: 1, stock_counts: 2 }] });

    await expect(getOperationStock(ctx)).resolves.toMatchObject({
      rows: [{ stock_id: 'stock-a' }],
      pending: { item_registrations: 1, stock_counts: 2 },
    });

    const sql = String(mocks.query.mock.calls[0]?.[0]);
    expect(sql).toContain('environment=$1 AND unit_id=$2');
    expect(sql).not.toContain('average_cost');
    expect(sql).not.toContain('sale_price');
    expect(sql).not.toContain('supplier_name');
  });

  it('cadastra pneu como solicitação pendente sem preço, custo ou saldo', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ id: 'request-a', status: 'pending', created_at: '2026-08-10T00:00:00Z' }],
    });

    await requestOperationItemRegistration(ctx, 'Wallace', {
      item_type: 'pneu',
      item_name: 'Maggion Matrix',
      tire_width_mm: 90,
      tire_aspect_ratio: 90,
      tire_rim_diameter: 18,
      tire_condition: 'novo',
      minimum_quantity: 2,
      idempotency_key: 'item-12345678',
    });

    const sql = String(mocks.query.mock.calls[0]?.[0]);
    expect(sql).toContain('partner_item_registration_requests');
    expect(sql).not.toContain('average_cost');
    expect(sql).not.toContain('sale_price');
    expect(sql).not.toContain('quantity_on_hand');
    expect(mocks.query.mock.calls[0]?.[1]).toContain('90/90-18');
  });

  it('fotografa o saldo na contagem sem atualizar o estoque oficial', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: 'stock-a', quantity_on_hand: 12, is_tracked: true, item_type: 'pneu', updated_at: '2026-08-10T10:00:00Z' }] })
      .mockResolvedValueOnce({
        rows: [{ id: 'count-a', status: 'pending', created_at: '2026-08-10T00:00:00Z', quantity_snapshot: 12 }],
      });

    await expect(requestOperationStockCount(ctx, 'Wallace', {
      stock_id: 'stock-a',
      counted_quantity: 11,
      reason: 'rotina',
      idempotency_key: 'count-12345678',
    })).resolves.toMatchObject({ status: 'pending', quantity_snapshot: 12 });

    expect(String(mocks.query.mock.calls[1]?.[0])).toContain('partner_stock_count_requests');
    expect(String(mocks.query.mock.calls[1]?.[0])).toContain('stock_updated_at_snapshot');
    expect(mocks.query.mock.calls[1]?.[1]).toContain('2026-08-10T10:00:00Z');
    expect(mocks.query.mock.calls.map((call) => String(call[0])).join('\n'))
      .not.toContain('UPDATE commerce.partner_stock_levels');
  });

  it('envia um lote de contagens na mesma transação e conserva o batch_id', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [
        { id: 'stock-a', quantity_on_hand: 12, is_tracked: true, item_type: 'pneu', updated_at: '2026-08-10T10:00:00Z' },
        { id: 'stock-b', quantity_on_hand: 1, is_tracked: true, item_type: 'pneu', updated_at: '2026-08-10T10:00:00Z' },
      ] })
      .mockResolvedValueOnce({ rows: [{ id: 'count-a', stock_id: 'stock-a', status: 'pending' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'count-b', stock_id: 'stock-b', status: 'pending' }] });

    const result = await requestOperationStockCountBatch(ctx, 'Wallace', {
      batch_id: '10000000-0000-4000-8000-000000000001',
      items: [
        { stock_id: 'stock-a', counted_quantity: 12, reason: 'rotina', idempotency_key: 'count-a-12345678' },
        { stock_id: 'stock-b', counted_quantity: 3, reason: 'divergencia', reason_detail: 'Mercadoria encontrada', idempotency_key: 'count-b-12345678' },
      ],
    });

    expect(result.requests).toHaveLength(2);
    expect(String(mocks.query.mock.calls[1]?.[0])).toContain('batch_id');
    expect(mocks.query.mock.calls[2]?.[1]).toContain('Mercadoria encontrada');
    expect(mocks.query.mock.calls.map((call) => String(call[0])).join('\n'))
      .not.toContain('UPDATE commerce.partner_stock_levels');
  });

  it('anexa foto somente à contagem pendente criada pelo mesmo funcionário', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'evidence-a' }] });

    await expect(attachOperationStockCountEvidence(ctx, 'count-a', {
      bytes: Buffer.from('jpeg'), mime: 'image/jpeg', sizeBytes: 4,
    })).resolves.toBe('attached');

    const sql = String(mocks.query.mock.calls[0]?.[0]);
    expect(sql).toContain("r.status='pending'");
    expect(sql).toContain('r.requested_by_token_id=$8');
    expect(mocks.query.mock.calls[0]?.[1]).toContain('token-a');
  });

  it('recusa contagem de serviço ou item sem controle de saldo', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ id: 'service-a', quantity_on_hand: null, is_tracked: false, item_type: 'servico' }],
    });

    await expect(requestOperationStockCount(ctx, 'Wallace', {
      stock_id: 'service-a',
      counted_quantity: 1,
      reason: 'rotina',
      idempotency_key: 'count-87654321',
    })).rejects.toThrow('stock_unavailable_for_count');
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });
});

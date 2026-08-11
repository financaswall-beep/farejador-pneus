import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PartnerContext } from '../../../src/parceiro/auth.js';

const mocks = vi.hoisted(() => ({
  partnerQuery: vi.fn(), ownerQuery: vi.fn(), release: vi.fn(),
}));
vi.mock('../../../src/parceiro/db.js', () => ({
  withPartnerContext: vi.fn((_partnerUnitId: string, work: (client: unknown) => unknown) =>
    work({ query: mocks.partnerQuery })),
}));
vi.mock('../../../src/persistence/db.js', () => ({
  pool: { connect: vi.fn(async () => ({ query: mocks.ownerQuery, release: mocks.release })) },
}));

import {
  approveOperationStockUpdate,
  OperationStockUpdateError,
  requestOperationStockUpdate,
} from '../../../src/parceiro/operation-stock-update.js';
import { OperationStockReviewError } from '../../../src/parceiro/operation-stock-owner.js';

const ctx: PartnerContext = {
  environment: 'test', partnerId: 'partner-a', partnerUnitId: 'partner-unit-a',
  unitId: 'unit-a', slug: 'loja-a', partnerName: 'Parceiro A', unitName: 'Unidade A',
  role: 'employee', tokenId: 'employee-token',
};
const current = {
  local_sku: '10458', item_name: 'Matrix Plus CG', item_type: 'pneu' as const,
  tire_size: '90/90-18', tire_width_mm: 90, tire_aspect_ratio: 90,
  tire_rim_diameter: 18, brand: 'Maggion', minimum_quantity: 2,
  tire_condition: 'novo' as const, shelf_location: 'A-01', tire_position: 'Dianteiro',
};

beforeEach(() => {
  mocks.partnerQuery.mockReset(); mocks.ownerQuery.mockReset(); mocks.release.mockReset();
});

describe('edição protegida do estoque operacional', () => {
  it('cria pedido isolado pela unidade sem aceitar campos financeiros', async () => {
    mocks.partnerQuery
      .mockResolvedValueOnce({ rows: [current] })
      .mockResolvedValueOnce({ rows: [{ id: 'request-a', status: 'pending', created_at: 'now' }] });

    await expect(requestOperationStockUpdate(ctx, 'Wallace', 'stock-a', {
      item_name: 'Matrix Street CG', brand: 'Maggion', local_sku: '10458',
      tire_width_mm: 100, tire_aspect_ratio: 80, tire_rim_diameter: 18,
      tire_condition: 'novo', tire_position: 'Traseiro', minimum_quantity: 3,
      shelf_location: 'A-02', idempotency_key: 'edit-request-a',
    })).resolves.toMatchObject({ id: 'request-a', status: 'pending' });

    const selectSql = String(mocks.partnerQuery.mock.calls[0]?.[0]);
    const insertSql = String(mocks.partnerQuery.mock.calls[1]?.[0]);
    expect(selectSql).toContain('environment=$2 AND unit_id=$3');
    expect(insertSql).toContain('stock_metadata_snapshot');
    expect(insertSql).not.toContain('average_cost');
    expect(insertSql).not.toContain('sale_price');
    expect(insertSql).not.toContain('quantity_on_hand');
  });

  it('exige os campos estruturais ao editar um pneu', async () => {
    mocks.partnerQuery.mockResolvedValueOnce({ rows: [current] });
    await expect(requestOperationStockUpdate(ctx, 'Wallace', 'stock-a', {
      item_name: 'Matrix', idempotency_key: 'edit-request-b',
    })).rejects.toMatchObject<Partial<OperationStockUpdateError>>({ code: 'tire_fields_required' });
  });

  it('aprova somente metadados e registra auditoria sem mexer no financeiro ou saldo', async () => {
    mocks.ownerQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT r.id')) return { rows: [{
        id: 'request-a', status: 'pending', target_stock_id: 'stock-a', is_stale: false,
        metadata_before: current, ...current, item_name: 'Matrix Street CG',
      }] };
      return { rows: [] };
    });

    await expect(approveOperationStockUpdate(ctx, 'Proprietário', 'request-a'))
      .resolves.toMatchObject({ stock_id: 'stock-a', status: 'approved' });
    const stockUpdate = mocks.ownerQuery.mock.calls
      .map((call) => String(call[0])).find((sql) => sql.includes('UPDATE commerce.partner_stock_levels SET'))!;
    expect(stockUpdate).toContain('item_name=$5');
    expect(stockUpdate).not.toMatch(/average_cost\s*=/);
    expect(stockUpdate).not.toMatch(/sale_price\s*=/);
    expect(stockUpdate).not.toMatch(/quantity_on_hand\s*=/);
    expect(mocks.ownerQuery.mock.calls.some((call) => String(call[0]).includes('partner_stock_update_approved'))).toBe(true);
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('bloqueia aprovação quando o cadastro mudou depois da solicitação', async () => {
    mocks.ownerQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT r.id')) return { rows: [{
        id: 'request-a', status: 'pending', target_stock_id: 'stock-a', is_stale: true,
        metadata_before: current, ...current,
      }] };
      return { rows: [] };
    });
    await expect(approveOperationStockUpdate(ctx, 'Proprietário', 'request-a'))
      .rejects.toMatchObject<Partial<OperationStockReviewError>>({ code: 'stock_update_stale' });
    expect(mocks.ownerQuery.mock.calls.some((call) => String(call[0]).includes('ROLLBACK'))).toBe(true);
  });
});

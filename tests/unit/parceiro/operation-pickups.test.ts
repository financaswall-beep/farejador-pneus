import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PartnerContext } from '../../../src/parceiro/auth.js';
import { markPartnerPickupRetrieved, getPartnerRetiradas } from '../../../src/parceiro/pickup-queries.js';
import { getPartnerPickupPhoto } from '../../../src/parceiro/operation-pickup-photo.js';

const mocks = vi.hoisted(() => ({ query: vi.fn(), read: vi.fn(), services: vi.fn() }));
vi.mock('../../../src/parceiro/db.js', () => ({ withPartnerContext: (_id: string, work: any) => work({ query: mocks.query }) }));
vi.mock('../../../src/photos/storage.js', () => ({ readStoredTirePhoto: mocks.read }));
vi.mock('../../../src/shared/pickup-service-persistence.js', () => ({ materializePartnerPickupServices: mocks.services }));
const ctx = { partnerUnitId: 'network-unit', unitId: 'unit-a', environment: 'test', tokenId: 'token-a', slug: 'loja' } as PartnerContext;

describe('motor de retirada simplificado', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.services.mockResolvedValue(0); });
  it.each(['Dinheiro', 'Pix', null])('preserva a forma registrada (%s), sem inventar pagamento', async method => {
    mocks.query.mockResolvedValue({ rows: [], rowCount: 1 });
    mocks.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ awaiting_pickup: true, status: 'confirmed', total_amount: '180.00',
      customer_id: null, customer_name: 'Teste', payment_method: method, pickup_services: [] }] });
    await expect(markPartnerPickupRetrieved(ctx, 'order-a', {})).resolves.toEqual({ order_id: 'order-a', retrieved: true });
    const receipt = mocks.query.mock.calls.find(call => call[0].includes('INSERT INTO finance.partner_receivables'))!;
    expect(receipt[1][6]).toBe(method);
    expect(mocks.query.mock.calls[0][0]).toContain('FOR UPDATE');
    expect(mocks.query.mock.calls[0][1]).toEqual(['order-a', 'test', 'unit-a']);
  });
  it('não baixa estoque novamente quando a retirada já foi concluída', async () => {
    mocks.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ awaiting_pickup: false, status: 'paid' }] });
    await expect(markPartnerPickupRetrieved(ctx, 'order-a', {})).rejects.toThrow('pickup_already_retrieved');
    expect(mocks.query).toHaveBeenCalledTimes(1); expect(mocks.services).not.toHaveBeenCalled();
  });
  it('busca avatar e metadados somente na unidade e ambiente da retirada', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] }); await getPartnerRetiradas(ctx);
    const [sql, params] = mocks.query.mock.calls[0];
    expect(params).toEqual(['test', 'unit-a']);
    expect(sql).toContain('pc.environment=po.environment AND pc.unit_id=po.unit_id');
    expect(sql).toContain('pr.order_item_id=item.id'); expect(sql).toContain('blob.deleted_at IS NULL');
  });
  it('imagem ausente ou de outra retirada não é lida do Storage', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] }); mocks.read.mockResolvedValue(null);
    await expect(getPartnerPickupPhoto(ctx, 'order-b', 'item-a')).resolves.toBeNull();
    expect(mocks.read).toHaveBeenCalledWith(undefined);
    const [sql, params] = mocks.query.mock.calls[0];
    expect(params).toEqual(['order-b', 'item-a', 'test', 'unit-a']);
    expect(sql).toContain('po.id=$1 AND item.id=$2'); expect(sql).toContain("po.fulfillment_mode='pickup'");
    expect(sql).toContain('blob.deleted_at IS NULL');
  });
});

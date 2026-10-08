import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PartnerContext } from '../../../src/parceiro/auth.js';
import { getPartnerOperationDeliveries, getPartnerOperationDeliveryPhoto } from '../../../src/parceiro/operation-deliveries.js';
const mocks = vi.hoisted(() => ({ query: vi.fn(), read: vi.fn(), inTransaction: false }));
vi.mock('../../../src/parceiro/db.js', () => ({ withPartnerContext: async (_: string, work: any) => {
  mocks.inTransaction = true; try { return await work({ query: mocks.query }); } finally { mocks.inTransaction = false; }
} }));
vi.mock('../../../src/photos/storage.js', () => ({ readStoredTirePhoto: mocks.read }));
const ctx = { partnerUnitId: 'partner-a', unitId: 'unit-a', environment: 'test' } as PartnerContext;
beforeEach(() => { vi.clearAllMocks(); });
describe('feed de entregas com fotos e identidade', () => {
  it('mantém paginação e rótulo antigo e inclui tamanho e fotos por item', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ order_id: 'order-a', total_amount: '180.00', total_count: '3', total_preparing: 2,
      total_dispatched: 1, total_delivered: 0, total_returns: 0, customer_avatar_url: 'https://chat.example/avatar.png',
      items: [{ order_item_id: 'item-a', quantity: '1', tire_size: '90/90-18', brand: 'Pirelli', tire_condition: 'meia_vida', photo_request_id: 'photo-a' },
        { order_item_id: 'item-b', quantity: '2', tire_size: '80/100-14', brand: 'Levorin' }] }] });
    const result = await getPartnerOperationDeliveries(ctx, { page: 2, limit: 1 });
    expect(result.rows[0].total_amount).toBe(180);
    expect(result.rows[0].items[0]).toMatchObject({ quantity: 1, label: 'Pirelli 90/90-18', tire_size: '90/90-18', photo_request_id: 'photo-a' });
    expect(result.rows[0].items[1]).toMatchObject({ quantity: 2, photo_request_id: null });
    expect(result.pagination).toEqual({ view: 'active', page: 2, limit: 1, total: 3, has_more: true });
    expect(result.summary).toEqual({ preparing: 2, dispatched: 1, delivered: 0, returns: 0 });
    const [sql, args] = mocks.query.mock.calls[0]; expect(args).toEqual(['test', 'unit-a', 'active', 1, 1]);
    expect(sql).toContain('pc.environment=pof.environment AND pc.unit_id=pof.unit_id');
    expect(sql).toContain('pr.order_item_id=item.id AND pr.unit_id=pof.unit_id');
    expect(sql).toContain('blob.unit_id=pof.unit_id AND blob.deleted_at IS NULL');
  });
  it('lê Storage somente depois de liberar a conexão e respeita a unidade da foto', async () => {
    const photo = { storage_path: 'restricted/photo.webp', mime: 'image/webp', bytes: null };
    mocks.query.mockResolvedValueOnce({ rows: [photo] });
    mocks.read.mockImplementation(async () => { expect(mocks.inTransaction).toBe(false); return { bytes: Buffer.from('test'), mime: 'image/webp' }; });
    await getPartnerOperationDeliveryPhoto(ctx, 'photo-a');
    expect(mocks.read).toHaveBeenCalledWith(photo);
    const [sql, args] = mocks.query.mock.calls[0]; expect(args).toEqual(['photo-a', 'test', 'unit-a']);
    expect(sql).toContain('pr.unit_id = po.unit_id AND blob.unit_id = po.unit_id'); expect(sql).toContain('blob.deleted_at IS NULL');
  });
});

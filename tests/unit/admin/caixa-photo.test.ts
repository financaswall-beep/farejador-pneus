import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  attachCaixaPhoto,
  getCaixaMainUnitId,
  getCaixaPhotoQueue,
} from '../../../src/admin/caixa/photo.js';

vi.mock('../../../src/persistence/db.js', () => ({ pool: {} }));

describe('pedidos de foto do Frente de Caixa', () => {
  it('lista somente pedidos vivos da unidade main sem expor dados da conversa', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'main-unit' }] })
      .mockResolvedValueOnce({ rows: [{
        id: '11111111-1111-4111-8111-111111111111',
        tire_size: '90/90-18',
        brand: 'Pirelli',
        note: null,
        customer_name: 'Marcos',
        expires_at: '2026-08-05T02:20:00.000Z',
        created_at: '2026-08-05T02:10:00.000Z',
      }] });
    const dbPool = { query } as unknown as Pool;

    await expect(getCaixaMainUnitId('prod', dbPool)).resolves.toBe('main-unit');
    const queue = await getCaixaPhotoQueue('prod', dbPool);

    expect(queue).toHaveLength(1);
    expect(queue[0]).not.toHaveProperty('conversation_id');
    expect(queue[0]).not.toHaveProperty('phone');
    const sql = String(query.mock.calls[1]?.[0]);
    expect(sql).toContain("u.slug='main'");
    expect(sql).toContain("pr.status='pending'");
    expect(sql).toContain('pr.expires_at>now()');
    expect(query.mock.calls[1]?.[1]).toEqual(['prod']);
  });

  it('anexa a foto somente depois de travar um pedido pertencente à main', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'request-id' }] })
      .mockResolvedValueOnce({ rows: [{
        out_status: 'answered', out_was_late: false, out_attached: true,
      }] })
      .mockResolvedValueOnce({ rows: [] });
    const release = vi.fn();
    const dbPool = {
      connect: vi.fn().mockResolvedValue({ query, release }),
    } as unknown as Pool;

    const result = await attachCaixaPhoto('prod', 'request-id', {
      bytes: Buffer.from('jpeg'), mime: 'image/jpeg', sizeBytes: 4,
    }, dbPool);

    expect(result).toEqual({ status: 'ok', state: 'answered', was_late: false, attached: true });
    expect(query.mock.calls.map((call) => String(call[0]))).toEqual([
      'BEGIN', expect.stringContaining("u.slug='main'"),
      expect.stringContaining('commerce.attach_partner_photo'), 'COMMIT',
    ]);
    expect(query.mock.calls[1]?.[1]).toEqual(['prod', 'request-id']);
    expect(release).toHaveBeenCalledOnce();
  });

  it('rejeita pedido de outra unidade antes de gravar bytes', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const release = vi.fn();
    const dbPool = {
      connect: vi.fn().mockResolvedValue({ query, release }),
    } as unknown as Pool;

    await expect(attachCaixaPhoto('test', 'other-request', {
      bytes: Buffer.from('jpeg'), mime: 'image/jpeg', sizeBytes: 4,
    }, dbPool)).resolves.toEqual({ status: 'not_found' });

    expect(query.mock.calls.map((call) => String(call[0]))).toEqual([
      'BEGIN', expect.stringContaining("u.slug='main'"), 'ROLLBACK',
    ]);
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining('attach_partner_photo'), expect.anything());
    expect(release).toHaveBeenCalledOnce();
  });
});

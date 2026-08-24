import type { Pool, PoolClient } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyMatrizGalpaoReturn } from '../../../src/atendente-v2/wholesale-stock-read.js';
import { releaseMatrizGalpaoReservation } from '../../../src/atendente-v2/matriz-stock-reservation.js';
import { postMatrizRetailCancellation } from '../../../src/admin/painel/matriz-ledger-retail-sales.js';
import { cancelMatrizPickup } from '../../../src/admin/painel/queries-pickup-cancel.js';

vi.mock('../../../src/persistence/db.js', () => ({ pool: {} }));
vi.mock('../../../src/shared/config/env.js', () => ({ env: { FAREJADOR_ENV: 'test' } }));
vi.mock('../../../src/atendente-v2/wholesale-stock-read.js', () => ({
  applyMatrizGalpaoReturn: vi.fn(),
}));
vi.mock('../../../src/atendente-v2/matriz-stock-reservation.js', () => ({
  releaseMatrizGalpaoReservation: vi.fn(),
}));
vi.mock('../../../src/admin/painel/matriz-ledger-retail-sales.js', () => ({
  postMatrizRetailCancellation: vi.fn(),
}));

function fakePool(query: ReturnType<typeof vi.fn>) {
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  return { client, pool: { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool };
}

describe('cancelamento estreito de retirada da Matriz', () => {
  beforeEach(() => vi.clearAllMocks());

  it('recusa UUID de venda que não seja retirada aberta e reservada', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const { pool, client } = fakePool(query);

    await expect(cancelMatrizPickup({
      order_id: '00000000-0000-4000-8000-000000000001',
      actor_label: 'teste', reason: 'fora do escopo', environment: 'test',
    }, pool)).rejects.toThrow('pickup_not_found');

    expect(String(query.mock.calls[1]?.[0])).toContain("pickup.fulfillment_mode='pickup'");
    expect(String(query.mock.calls[1]?.[0])).toContain("reservation.event_type='matriz_galpao_reserved'");
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledOnce();
    expect(releaseMatrizGalpaoReservation).not.toHaveBeenCalled();
  });

  it('cancela e libera a reserva na mesma transação', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ updated_at: 'antes' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ updated_at: '2026-08-23T12:00:00Z' }] })
      .mockResolvedValueOnce({ rows: [] });
    const { pool } = fakePool(query);
    const input = {
      order_id: '00000000-0000-4000-8000-000000000002',
      actor_label: 'Caixa: Dono', reason: 'cliente desistiu', environment: 'test' as const,
    };

    await expect(cancelMatrizPickup(input, pool)).resolves.toEqual({ cancelled: true });

    expect(releaseMatrizGalpaoReservation).toHaveBeenCalledOnce();
    expect(applyMatrizGalpaoReturn).toHaveBeenCalledOnce();
    expect(postMatrizRetailCancellation).toHaveBeenCalledWith(
      expect.anything(), 'test', input.order_id, '2026-08-23T12:00:00Z',
      input.actor_label, input.reason,
    );
    expect(query).toHaveBeenLastCalledWith('COMMIT');
  });
});

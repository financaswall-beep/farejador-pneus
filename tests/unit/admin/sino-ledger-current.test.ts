import { beforeEach, describe, expect, it, vi } from 'vitest';

const { read, env } = vi.hoisted(() => ({
  read: vi.fn(), env: { MATRIZ_CENTRAL_LEDGER: true },
}));
vi.mock('../../../src/shared/config/env.js', () => ({ env }));
vi.mock('../../../src/persistence/db.js', () => ({ pool: {} }));
vi.mock('../../../src/admin/painel/matriz-ledger-integration-health.js', () => ({
  getMatrizLedgerIntegrationHealth: read,
}));
import { currentLedgerHealth } from '../../../src/operation/daily-ledger-health.js';

describe('conferência financeira atual do sino', () => {
  beforeEach(() => { read.mockReset(); env.MATRIZ_CENTRAL_LEDGER = true; });
  it('retira o aviso resolvido no mesmo dia sem reutilizar o resumo diário', async () => {
    const db = { query: vi.fn(async () => ({ rows: [
      { status: 'yellow', pending_signals: 22, error_signals: 0 },
    ] })) };
    read.mockResolvedValue({ status: 'green', checked_at: '2026-10-19T23:00:00Z',
      global: { total_error_signals: 0 }, modules: { financeiro: { pending: 0 } } });
    expect(await currentLedgerHealth('prod', db as never)).toEqual({
      status: 'green', checked_at: '2026-10-19T23:00:00Z', error_signals: 0, pending_signals: 0,
    });
    expect(read).toHaveBeenCalledWith('prod', db);expect(db.query).not.toHaveBeenCalled();
    read.mockResolvedValue({ status: 'red', checked_at: '2026-10-19T23:01:00Z',
      global: { total_error_signals: 2 }, modules: { marketing: { pending: 1 }, logistica: { pending: 3 } } });
    expect(await currentLedgerHealth('prod', db as never)).toMatchObject({
      status: 'red', error_signals: 2, pending_signals: 4,
    });
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('não apresenta ausência de pendências quando a conferência falha', async () => {
    read.mockRejectedValue(Error('database unavailable'));
    await expect(currentLedgerHealth('test', {} as never)).rejects.toThrow('database unavailable');
  });
  it('respeita a desativação do financeiro central', async () => {
    env.MATRIZ_CENTRAL_LEDGER = false;
    expect(await currentLedgerHealth('test', {} as never)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
});

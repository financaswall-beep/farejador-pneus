import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { resolveMetaCatchupLookback } from '../../../src/marketing/catchup.js';

describe('retomada automática do Marketing', () => {
  it.each([
    [60, 60],
    [61, 61],
    [500, 60],
  ])('aceita resultado seguro %s como %s', async (databaseValue, expected) => {
    const query = vi.fn().mockResolvedValue({ rows: [{ lookback_days: databaseValue }] });
    await expect(resolveMetaCatchupLookback(
      { query } as unknown as Pool, 'prod', '2026-08-22',
    )).resolves.toBe(expected);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('LEAST(365'), [
      'prod', '2026-08-22',
    ]);
  });

  it('usa 60 dias quando ainda não existe execução concluída', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ lookback_days: '60' }] });
    await expect(resolveMetaCatchupLookback(
      { query } as unknown as Pool, 'prod', '2026-08-22',
    )).resolves.toBe(60);
  });
});

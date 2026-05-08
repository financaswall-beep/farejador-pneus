import { describe, expect, it, vi } from 'vitest';
import { pickEnrichmentJob } from '../../../../src/shared/repositories/ops-phase3.repository.js';

describe('pickEnrichmentJob', () => {
  it('inclui jobs running com lock vencido no pickup da Organizadora', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] });

    await pickEnrichmentJob({ query } as never, 'test', 900);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("status IN ('pending', 'queued')");
    expect(sql).toContain("status = 'running'");
    expect(sql).toContain('locked_at < now() - ($2::int * interval');
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(params).toEqual(['test', 900]);
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { inspectOperationalContinuity } from '../../../src/admin/operational-health.js';

function row(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 199,
    missing_partitions: 0,
    partition_job_active: true,
    retention_job_active: true,
    partition_last_success: '2026-08-20T03:00:00.000Z',
    retention_last_success: '2026-08-22T04:30:00.000Z',
    latest_raw_event: '2026-08-22T02:00:00.000Z',
    stale_raw_pending: 0,
    recent_raw_failed: 0,
    open_dead_letters: 0,
    stuck_jobs: 0,
    stuck_outbound: 0,
    stale_meta_runs: 0,
    latest_meta_success: '2026-08-22T01:00:00.000Z',
    cron_history_bytes: 1024,
    ...overrides,
  };
}

describe('continuidade operacional', () => {
  const now = new Date('2026-08-22T06:00:00.000Z');

  it('aprova estrutura saudável sem esconder os indicadores', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [row()] });
    const result = await inspectOperationalContinuity(
      { query } as unknown as Pool, 'prod', now,
    );

    expect(result.critical).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.details).toMatchObject({ schema_version: 199, missing_partitions: 0 });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('farejador-ensure-partitions'), ['prod']);
  });

  it('bloqueia prontidão sem schema, partição ou renovação automática', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [row({
      schema_version: 198,
      missing_partitions: 2,
      partition_job_active: false,
    })] });
    const result = await inspectOperationalContinuity(
      { query } as unknown as Pool, 'prod', now,
    );

    expect(result.critical).toEqual([
      'schema_marker_outdated', 'future_partitions_missing', 'partition_job_inactive',
    ]);
  });

  it('degrada sem derrubar o serviço quando uma fila precisa de atenção', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [row({
      latest_raw_event: '2026-08-20T00:00:00.000Z',
      stale_raw_pending: 3,
      open_dead_letters: 11,
      retention_last_success: null,
    })] });
    const result = await inspectOperationalContinuity(
      { query } as unknown as Pool, 'prod', now,
    );

    expect(result.critical).toEqual([]);
    expect(result.warnings).toEqual(expect.arrayContaining([
      'retention_job_not_observed', 'chatwoot_ingestion_stale',
      'raw_events_pending_stale', 'dead_letters_open',
    ]));
  });
});

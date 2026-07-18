import { describe, expect, it, vi } from 'vitest';
import {
  loadStaleTriggerCheck,
  markAtendenteJobFailed,
  reclaimStaleAtendenteJobs,
} from '../../../src/shared/repositories/ops-atendente.repository.js';
import { classifyAtendenteError as classifyFailure } from '../../../src/shared/repositories/ops-atendente-retry.js';

describe('ops.atendente_jobs resilience helpers', () => {
  it('classifies PostgreSQL serialization and connection codes as transient', () => {
    expect(classifyFailure(Object.assign(new Error('could not serialize access'), { code: '40001' })).retryable)
      .toBe(true);
    expect(classifyFailure(Object.assign(new Error('database restarting'), { code: '57P01' })).retryable)
      .toBe(true);
  });
  it('counts sent_api_ack as answered for the stale-trigger guard', async () => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [{ this_trigger_at: null, last_answered_trigger_at: null }] }),
    };

    await loadStaleTriggerCheck(client as never, 'prod', 'conv-1', 'msg-1');

    expect(client.query.mock.calls[0]?.[0]).toContain("t.status IN ('delivered', 'sent_api_ack')");
  });

  it('requeues retryable failures using not_before instead of a duplicate next_attempt_at', async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ attempts: 1 }] })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }),
    };

    await markAtendenteJobFailed(client as never, 'job-1', 'OpenAI request aborted');

    const updateSql = client.query.mock.calls[1]?.[0] as string;
    const params = client.query.mock.calls[1]?.[1] as unknown[];
    expect(updateSql).toContain("status        = 'pending'");
    expect(updateSql).toContain('not_before');
    expect(updateSql).not.toContain('next_attempt_at');
    expect(params[2]).toBe('60');
  });

  it('moves non-retryable configuration failures to DLQ with sanitized ledger', async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ attempts: 1, environment: 'prod' }] })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }),
    };

    await markAtendenteJobFailed(
      client as never, 'job-1', 'Chatwoot API configuration is missing token=abc12345678901234567890', true,
    );

    const updateSql = client.query.mock.calls[1]?.[0] as string;
    const updateParams = client.query.mock.calls[1]?.[1] as unknown[];
    expect(updateSql).toContain('status        = $3');
    expect(updateParams[2]).toBe('dead_letter');
    expect(updateParams[1]).not.toContain('abc12345678901234567890');
    expect(String(client.query.mock.calls[2]?.[0])).toContain('atendente_job_events');
    expect(String(client.query.mock.calls[3]?.[0])).toContain('atendente_dead_letters');
  });

  it('reclaims old processing jobs back to pending with not_before', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [{ id: 'job-1' }], rowCount: 1 }) };

    const reclaimed = await reclaimStaleAtendenteJobs(client as never, 'prod');

    expect(reclaimed).toBe(1);
    const sql = client.query.mock.calls[0]?.[0] as string;
    expect(sql).toContain("status = CASE WHEN attempts < $2 THEN 'pending' ELSE $4 END");
    expect(sql).toContain("status = 'processing'");
    expect(sql).toContain('locked_at < now()');
  });
});

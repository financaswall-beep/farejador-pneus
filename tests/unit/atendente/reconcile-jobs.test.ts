import { afterEach, describe, expect, it, vi } from 'vitest';

const baseEnv = {
  NODE_ENV: 'test',
  FAREJADOR_ENV: 'prod',
  DATABASE_URL: 'postgresql://postgres:password@example.test:6543/postgres',
  CHATWOOT_HMAC_SECRET: 'test-secret',
  ADMIN_AUTH_TOKEN: 'test-admin-token',
  ORGANIZADORA_ENABLED: 'false',
  ATENDENTE_SHADOW_ENABLED: 'true',
};

async function loadReconcileJobs() {
  vi.resetModules();
  Object.assign(process.env, baseEnv);
  vi.doMock('pino', () => ({
    default: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  }));

  return import('../../../src/atendente/reconcile-jobs.js');
}

describe('atendente jobs reconciliation', () => {
  afterEach(() => {
    vi.doUnmock('pino');
    vi.resetModules();
  });

  it('creates sessions and jobs for contact messages without atendente job', async () => {
    const { reconcileMissingAtendenteJobs } = await loadReconcileJobs();
    const client = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('LEFT JOIN ops.atendente_jobs')) {
          return Promise.resolve({
            rows: [
              { conversation_id: 'conversation-1', message_id: 'message-1' },
              { conversation_id: 'conversation-1', message_id: 'message-2' },
            ],
          });
        }
        if (sql.includes('INSERT INTO agent.session_current')) {
          return Promise.resolve({ rows: [{ id: `session-${client.query.mock.calls.length}` }] });
        }
        if (sql.includes('ops.enqueue_atendente_job')) {
          return Promise.resolve({ rows: [{ enqueue_atendente_job: `job-${client.query.mock.calls.length}` }] });
        }
        return Promise.resolve({ rows: [] });
      }),
    };

    const result = await reconcileMissingAtendenteJobs(client as never, {
      environment: 'prod',
      since: new Date('2026-05-05T00:00:00Z'),
      until: new Date('2026-05-06T00:00:00Z'),
      limit: 100,
    });

    expect(result.candidates).toBe(2);
    expect(result.reconciled).toBe(2);
    expect(result.jobs).toHaveLength(2);

    const sessionCalls = client.query.mock.calls.filter((call) =>
      (call[0] as string).includes('INSERT INTO agent.session_current'),
    );
    const enqueueCalls = client.query.mock.calls.filter((call) =>
      (call[0] as string).includes('ops.enqueue_atendente_job'),
    );
    expect(sessionCalls).toHaveLength(2);
    expect(enqueueCalls).toHaveLength(2);
    expect(sessionCalls[0]?.[1]).toEqual(['prod', 'conversation-1', 'message-1']);
    expect(enqueueCalls[1]?.[1]).toEqual(['prod', 'conversation-1', 'message-2']);
  });

  it('returns zero without writing when no missing jobs exist', async () => {
    const { reconcileMissingAtendenteJobs } = await loadReconcileJobs();
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };

    const result = await reconcileMissingAtendenteJobs(client as never, {
      environment: 'prod',
      since: new Date('2026-05-05T00:00:00Z'),
      until: new Date('2026-05-06T00:00:00Z'),
      limit: 100,
    });

    expect(result).toEqual({ candidates: 0, reconciled: 0, jobs: [] });
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('wraps pool reconciliation in a transaction', async () => {
    const { reconcileMissingAtendenteJobsWithPool } = await loadReconcileJobs();
    const client = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('LEFT JOIN ops.atendente_jobs')) {
          return Promise.resolve({ rows: [{ conversation_id: 'conversation-1', message_id: 'message-1' }] });
        }
        if (sql.includes('INSERT INTO agent.session_current')) {
          return Promise.resolve({ rows: [{ id: 'session-1' }] });
        }
        if (sql.includes('ops.enqueue_atendente_job')) {
          return Promise.resolve({ rows: [{ enqueue_atendente_job: 'job-1' }] });
        }
        return Promise.resolve({ rows: [] });
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValue(client) };

    const result = await reconcileMissingAtendenteJobsWithPool(
      {
        environment: 'prod',
        since: new Date('2026-05-05T00:00:00Z'),
        until: new Date('2026-05-06T00:00:00Z'),
        limit: 100,
      },
      pool as never,
    );

    expect(result.reconciled).toBe(1);
    expect(client.query.mock.calls[0]?.[0]).toBe('BEGIN');
    expect(client.query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });
});
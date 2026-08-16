import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pollAndNormalize } from '../../../src/normalization/worker.js';
import { SkipEventError } from '../../../src/normalization/dispatcher.js';

interface MockClient {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

function createMockClient(rows: Array<Record<string, unknown>> = []): MockClient {
  const pendingRows = [...rows];
  const client: MockClient = {
    query: vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, event_type')) {
        const row = pendingRows.shift();
        return Promise.resolve({ rows: row ? [row] : [] });
      }
      if (sql.includes('SAVEPOINT') || sql.includes('RELEASE SAVEPOINT') || sql.includes('ROLLBACK TO SAVEPOINT')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('UPDATE raw.raw_events')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    }),
    release: vi.fn(),
  };
  return client;
}

const baseEnv = {
  NODE_ENV: 'test',
  FAREJADOR_ENV: 'prod',
  DATABASE_URL: 'postgresql://postgres:password@example.test:6543/postgres',
  CHATWOOT_HMAC_SECRET: 'test-secret',
  CHATWOOT_WEBHOOK_MAX_AGE_SECONDS: '300',
  ADMIN_AUTH_TOKEN: 'test-admin-token',
};

describe('worker pollAndNormalize', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock('pg');
    vi.doUnmock('pino');
    vi.resetModules();
  });

  async function loadWorker(
    client: MockClient,
  ): Promise<typeof import('../../../src/normalization/worker')> {
    vi.resetModules();
    Object.assign(process.env, baseEnv);

    vi.doMock('pino', () => ({
      default: vi.fn(() => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      })),
    }));

    vi.doMock('pg', () => ({
      Pool: vi.fn(function Pool() {
        return { connect: vi.fn().mockResolvedValue(client), on: vi.fn(), end: vi.fn() };
      }),
    }));

    return import('../../../src/normalization/worker.js');
  }

  it('marks events as processed on success', async () => {
    const client = createMockClient([
      { id: 1, event_type: 'contact_created', payload: { id: 201 }, environment: 'prod', chatwoot_timestamp: new Date() },
    ]);

    const worker = await loadWorker(client);
    await worker.pollAndNormalize();

    const updateCalls = client.query.mock.calls.filter((c) =>
      (c[0] as string).includes("SET processing_status = 'processed'"),
    );
    const beginCalls = client.query.mock.calls.filter((c) => c[0] === 'BEGIN');
    const commitCalls = client.query.mock.calls.filter((c) => c[0] === 'COMMIT');
    expect(updateCalls).toHaveLength(1);
    expect(beginCalls).toHaveLength(2);
    expect(commitCalls).toHaveLength(2);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('marks events as failed on dispatch error', async () => {
    const client = createMockClient([
      { id: 2, event_type: 'contact_created', payload: { id: 201 }, environment: 'prod', chatwoot_timestamp: new Date() },
    ]);

    // Simulate failure inside dispatch by making the first repository write throw.
    let selectConsumed = false;
    let callCount = 0;
    client.query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, event_type')) {
        if (selectConsumed) return Promise.resolve({ rows: [] });
        selectConsumed = true;
        return Promise.resolve({ rows: [{ id: 2, event_type: 'contact_created', payload: { id: 201 }, environment: 'prod', chatwoot_timestamp: new Date() }] });
      }
      if (sql.includes('SAVEPOINT')) return Promise.resolve({ rows: [] });
      if (sql.includes('ROLLBACK TO SAVEPOINT')) return Promise.resolve({ rows: [] });
      if (sql.includes('UPDATE raw.raw_events')) {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error('insert failed'));
        }
        return Promise.resolve({ rows: [] });
      }
      if (sql === 'BEGIN' || sql === 'COMMIT') return Promise.resolve({ rows: [] });
      return Promise.reject(new Error('insert failed'));
    });

    const worker = await loadWorker(client);
    await worker.pollAndNormalize();

    const failedCalls = client.query.mock.calls.filter((c) =>
      (c[0] as string).includes("SET processing_status = 'failed'"),
    );
    expect(failedCalls).toHaveLength(1);
  });

  it('marks unknown events as skipped', async () => {
    const client = createMockClient([
      { id: 3, event_type: 'unknown_event', payload: {}, environment: 'prod', chatwoot_timestamp: new Date() },
    ]);

    const worker = await loadWorker(client);
    await worker.pollAndNormalize();

    const skippedCalls = client.query.mock.calls.filter((c) =>
      (c[0] as string).includes("SET processing_status = 'skipped'"),
    );
    expect(skippedCalls).toHaveLength(1);
  });

  it('commits even when batch is empty', async () => {
    const client = createMockClient([]);

    const worker = await loadWorker(client);
    await worker.pollAndNormalize();

    const commitCalls = client.query.mock.calls.filter((c) => c[0] === 'COMMIT');
    expect(commitCalls).toHaveLength(1);
  });
});

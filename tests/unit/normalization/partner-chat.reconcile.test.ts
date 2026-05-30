import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const baseEnv = {
  NODE_ENV: 'test',
  FAREJADOR_ENV: 'prod',
  DATABASE_URL: 'postgresql://postgres:password@example.test:6543/postgres',
  CHATWOOT_HMAC_SECRET: 'test-secret',
  CHATWOOT_WEBHOOK_MAX_AGE_SECONDS: '300',
  ADMIN_AUTH_TOKEN: 'test-admin-token',
  AGENT_V2_WORKER_ENABLED: 'false',
};

// Stubs dos módulos que o reconciliador usa, pra isolar a orquestração.
const fanOutMock = vi.fn().mockResolvedValue(undefined);
const mapMessageMock = vi.fn((payload: Record<string, unknown>) => ({ chatwootMessageId: Number(payload.id) }));

vi.mock('../../../src/normalization/partner-chat.fanout.js', () => ({
  fanOutMessageToPartnerChat: (...args: unknown[]) => fanOutMock(...args),
}));
vi.mock('../../../src/normalization/message.mapper.js', () => ({
  mapMessage: (...args: unknown[]) => mapMessageMock(...(args as [Record<string, unknown>])),
}));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../src/persistence/db.js', () => ({ pool: {} }));

function makeClient(pendingRows: Array<{ id: number; payload: Record<string, unknown>; chatwoot_timestamp: Date | null }>) {
  const calls: string[] = [];
  return {
    calls,
    query: vi.fn().mockImplementation((sql: string) => {
      calls.push(sql.trim().split(/\s+/).slice(0, 2).join(' '));
      if (sql.includes('FROM raw.raw_events')) {
        return Promise.resolve({ rowCount: pendingRows.length, rows: pendingRows });
      }
      return Promise.resolve({ rowCount: 0, rows: [] });
    }),
  };
}

describe('partner chat reconcile', () => {
  beforeEach(() => {
    vi.resetModules();
    Object.assign(process.env, baseEnv, { PARTNER_CHAT_FANOUT_ENABLED: 'true' });
    fanOutMock.mockClear();
    mapMessageMock.mockClear();
  });
  afterEach(() => {
    delete process.env.PARTNER_CHAT_FANOUT_ENABLED;
  });

  async function load() {
    return (await import('../../../src/normalization/partner-chat.reconcile.js')).reconcilePartnerChatOnce;
  }

  it('reprocessa cada evento pendente pelo fan-out, em transação própria', async () => {
    const reconcile = await load();
    const client = makeClient([
      { id: 1, payload: { id: 19445 }, chatwoot_timestamp: null },
      { id: 2, payload: { id: 19447 }, chatwoot_timestamp: null },
    ]);

    const res = await reconcile(client as never);

    expect(res).toEqual({ candidates: 2, recovered: 2 });
    expect(fanOutMock).toHaveBeenCalledTimes(2);
    // cada mensagem em BEGIN/COMMIT
    expect(client.calls.filter((c) => c === 'BEGIN').length).toBe(2);
    expect(client.calls.filter((c) => c === 'COMMIT').length).toBe(2);
  });

  it('não faz nada quando não há pendências', async () => {
    const reconcile = await load();
    const client = makeClient([]);
    const res = await reconcile(client as never);
    expect(res).toEqual({ candidates: 0, recovered: 0 });
    expect(fanOutMock).not.toHaveBeenCalled();
  });

  it('um erro numa mensagem não derruba as outras (rollback isolado)', async () => {
    const reconcile = await load();
    const client = makeClient([
      { id: 1, payload: { id: 1 }, chatwoot_timestamp: null },
      { id: 2, payload: { id: 2 }, chatwoot_timestamp: null },
    ]);
    fanOutMock.mockRejectedValueOnce(new Error('boom')); // a primeira falha

    const res = await reconcile(client as never);

    expect(res.candidates).toBe(2);
    expect(res.recovered).toBe(1); // só a segunda entrou
    expect(client.calls).toContain('ROLLBACK');
  });
});

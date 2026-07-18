import { afterEach, describe, expect, it, vi } from 'vitest';

const baseEnv = {
  NODE_ENV: 'test',
  FAREJADOR_ENV: 'prod',
  DATABASE_URL: 'postgresql://postgres:password@example.test:6543/postgres',
  CHATWOOT_HMAC_SECRET: 'test-secret',
  ADMIN_AUTH_TOKEN: 'test-admin-token',
};

async function loadOutbox() {
  vi.resetModules();
  Object.assign(process.env, baseEnv);
  vi.doMock('pino', () => ({
    default: vi.fn(() => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  }));
  return import('../../../src/atendente-v2/outbox.js');
}

describe('agent_v2 outbox', () => {
  afterEach(() => {
    vi.doUnmock('pino');
    vi.resetModules();
  });

  it('detects customer messages newer than the draft trigger', async () => {
    const { hasNewerCustomerMessageAfterTrigger } = await loadOutbox();
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: 'newer-message' }] }),
    };

    const newer = await hasNewerCustomerMessageAfterTrigger(
      client as never,
      'prod',
      'conv-1',
      'trigger-1',
    );

    expect(newer).toBe('newer-message');
    const sql = client.query.mock.calls[0]?.[0] as string;
    expect(sql).toContain("m.sender_type = 'contact'");
    expect(sql).toContain('m.sent_at > t.sent_at');
  });

  it('marks an old draft as superseded instead of sending it', async () => {
    const { sendAgentTextWithOutbox } = await loadOutbox();
    const client = {
      query: vi.fn().mockResolvedValueOnce({ rows: [{ id: 'newer-message' }] }).mockResolvedValueOnce({ rows: [] }),
    };

    const result = await sendAgentTextWithOutbox(client as never, {
      environment: 'prod',
      conversationId: 'conv-1',
      triggerMessageId: 'trigger-1',
      jobId: 'job-1',
      chatwootConversationId: 123,
      body: 'resposta velha',
      actionsJson: '[]',
      inputTokens: 1,
      outputTokens: 1,
      durationMs: 10,
    });

    expect(result).toEqual({ status: 'superseded' });
    const insertSql = client.query.mock.calls[1]?.[0] as string;
    expect(insertSql).toContain("'superseded'");
    expect(insertSql).toContain('superseded_by_message_id');
  });

  it('keeps a previous sending row queued for ambiguity recovery without resending here', async () => {
    const { sendAgentTextWithOutbox } = await loadOutbox();
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] }) // newer customer message check
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // existing turn
        .mockResolvedValueOnce({ rows: [{ id: 'turn-1' }] }) // upsert turn
        .mockResolvedValueOnce({ rows: [{ id: 'out-1', status: 'sending', provider_message_id: null }] })
        .mockResolvedValueOnce({ rows: [] }), // COMMIT
    };

    const result = await sendAgentTextWithOutbox(client as never, {
      environment: 'prod',
      conversationId: 'conv-1',
      triggerMessageId: 'trigger-1',
      jobId: 'job-1',
      chatwootConversationId: 123,
      body: 'resposta talvez enviada',
      actionsJson: '[]',
      inputTokens: 1,
      outputTokens: 1,
      durationMs: 10,
    });

    expect(result).toEqual({
      status: 'queued', turnId: 'turn-1', outboundId: 'out-1', chatwootMessageId: null,
    });
    expect(client.query.mock.calls.map((call) => String(call[0])).join('\n')).not.toContain('status = \'sending\', attempts = attempts + 1');
  });

  it('uses the stable turn id as the provider echo id', async () => {
    const { sendAgentTextWithOutbox } = await loadOutbox();
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 'turn-stable' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'out-stable', status: 'pending', provider_message_id: null }] })
        .mockResolvedValueOnce({ rows: [] }),
    };

    await sendAgentTextWithOutbox(client as never, {
      environment: 'prod', conversationId: 'conv-1', triggerMessageId: 'trigger-1',
      jobId: 'job-1', chatwootConversationId: 123, body: 'texto', actionsJson: '[]',
      inputTokens: 1, outputTokens: 1, durationMs: 10,
    });

    expect(client.query.mock.calls[4]?.[1]?.[6]).toBe('turn:turn-stable');
  });
});

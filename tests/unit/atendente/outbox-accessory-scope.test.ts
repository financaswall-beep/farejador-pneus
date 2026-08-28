import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('accessory outbox conversation scope', () => {
  beforeEach(() => {
    vi.resetModules();
    Object.assign(process.env, {
      NODE_ENV: 'test',
      FAREJADOR_ENV: 'prod',
      DATABASE_URL: 'postgresql://postgres:password@example.test:6543/postgres',
      CHATWOOT_HMAC_SECRET: 'test-secret',
      ADMIN_AUTH_TOKEN: 'test-admin-token',
      AGENT_V2_CONVERSATION_IDS: 'conversation-allowed',
    });
  });

  it('insere texto acessório somente se o UUID interno estiver na lista', async () => {
    const { enqueueAccessoryText } = await import('../../../src/atendente-v2/outbox-accessory.js');
    const db = { query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [] }) };

    await enqueueAccessoryText(db as never, {
      environment: 'prod',
      chatwootConversationId: 123,
      kind: 'survey_text',
      body: 'Como foi o atendimento?',
      idempotencyKey: 'survey:1',
    });

    const [sql, params] = db.query.mock.calls[0]!;
    expect(String(sql)).toContain('c.id::text = ANY');
    expect(params.at(-2)).toBe(false);
    expect(params.at(-1)).toEqual(['conversation-allowed']);
  });
});

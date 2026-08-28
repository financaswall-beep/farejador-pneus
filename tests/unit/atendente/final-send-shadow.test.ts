import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('Agent V2 shadow delivery', () => {
  beforeEach(() => {
    vi.resetModules();
    Object.assign(process.env, {
      NODE_ENV: 'test',
      FAREJADOR_ENV: 'prod',
      DATABASE_URL: 'postgresql://postgres:password@example.test:6543/postgres',
      CHATWOOT_HMAC_SECRET: 'test-secret',
      ADMIN_AUTH_TOKEN: 'test-admin-token',
      BOT_OUTBOX: 'false',
    });
  });

  it('persiste a proposta como generated sem criar envio externo', async () => {
    const { sendFinalAgentText } = await import('../../../src/atendente-v2/final-send.js');
    const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };

    const result = await sendFinalAgentText(client as never, {
      jobId: 'job-1',
      conversationId: 'conversation-1',
      triggerMessageId: 'message-1',
      environment: 'prod',
      chatwootConversationId: 123,
      body: 'Resposta proposta, não enviada.',
      actions: [],
      inputTokens: 10,
      outputTokens: 5,
      durationMs: 100,
    });

    expect(result).toBe('shadowed');
    const allSql = client.query.mock.calls.map((call) => String(call[0])).join('\n');
    expect(allSql).toContain('INSERT INTO agent.turns');
    expect(allSql).toContain("'generated', 'shadow:no_external_send'");
    expect(allSql).not.toContain('INSERT INTO ops.outbound_messages');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

const baseEnv = {
  DATABASE_URL: 'postgresql://postgres:password@example.test:6543/postgres',
  CHATWOOT_HMAC_SECRET: 'test-secret',
  CHATWOOT_WEBHOOK_MAX_AGE_SECONDS: '300',
  ADMIN_AUTH_TOKEN: 'test-admin-token',
  FAREJADOR_ENV: 'prod',
  NODE_ENV: 'test',
};

const HANDLER_PATH = '../../../../src/atendente/handlers/escalate.js';
const CLIENT_PATH = '../../../../src/admin/chatwoot-api.client.js';

function createMockClient(chatwootConversationId: number | null = 42) {
  return {
    query: vi.fn().mockImplementation(() => {
      if (chatwootConversationId === null) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [{ chatwoot_conversation_id: chatwootConversationId }] });
    }),
  };
}

const escalateAction = {
  type: 'escalate' as const,
  reason: 'customer_requested' as const,
  summary_text: 'Cliente pediu para falar com humano. Está interessado em pneu Titan 140/70-17.',
};

describe('postEscalateNote', () => {
  beforeEach(() => {
    vi.resetModules();
    Object.assign(process.env, baseEnv);
    delete process.env.CHATWOOT_API_BASE_URL;
    delete process.env.CHATWOOT_API_TOKEN;
    delete process.env.CHATWOOT_ACCOUNT_ID;
  });

  it('não chama API quando CHATWOOT_API_BASE_URL está ausente', async () => {
    const mockCreateNote = vi.fn();
    vi.doMock(CLIENT_PATH, () => ({
      ChatwootApiClient: class { createNote = mockCreateNote; },
      ChatwootApiError: class extends Error {},
    }));

    const { postEscalateNote } = await import(HANDLER_PATH);
    const client = createMockClient();

    await postEscalateNote(client as never, 'prod', 'conv-uuid-1', escalateAction);

    expect(mockCreateNote).not.toHaveBeenCalled();
  });

  it('não chama API quando conversa não existe em core.conversations', async () => {
    process.env.CHATWOOT_API_BASE_URL = 'http://chatwoot.test/api/v1';
    process.env.CHATWOOT_API_TOKEN = 'token-test';
    process.env.CHATWOOT_ACCOUNT_ID = '1';

    const mockCreateNote = vi.fn();
    vi.doMock(CLIENT_PATH, () => ({
      ChatwootApiClient: class { createNote = mockCreateNote; },
      ChatwootApiError: class extends Error {},
    }));

    const { postEscalateNote } = await import(HANDLER_PATH);
    const client = createMockClient(null);

    await postEscalateNote(client as never, 'prod', 'conv-uuid-1', escalateAction);

    expect(mockCreateNote).not.toHaveBeenCalled();
  });

  it('chama createNote com o ID correto e inclui motivo e summary no corpo', async () => {
    process.env.CHATWOOT_API_BASE_URL = 'http://chatwoot.test/api/v1';
    process.env.CHATWOOT_API_TOKEN = 'token-test';
    process.env.CHATWOOT_ACCOUNT_ID = '1';

    const mockCreateNote = vi.fn().mockResolvedValue(undefined);
    vi.doMock(CLIENT_PATH, () => ({
      ChatwootApiClient: class { createNote = mockCreateNote; },
      ChatwootApiError: class extends Error {},
    }));

    const { postEscalateNote } = await import(HANDLER_PATH);
    const client = createMockClient(99);

    await postEscalateNote(client as never, 'prod', 'conv-uuid-1', escalateAction);

    expect(mockCreateNote).toHaveBeenCalledOnce();
    const [conversationId, body] = mockCreateNote.mock.calls[0] as [number, string];
    expect(conversationId).toBe(99);
    expect(body).toContain('Cliente pediu atendimento humano');
    expect(body).toContain(escalateAction.summary_text);
  });

  it('não lança exceção quando a API falha — apenas loga warn', async () => {
    process.env.CHATWOOT_API_BASE_URL = 'http://chatwoot.test/api/v1';
    process.env.CHATWOOT_API_TOKEN = 'token-test';
    process.env.CHATWOOT_ACCOUNT_ID = '1';

    const mockCreateNote = vi.fn().mockRejectedValue(new Error('Chatwoot down'));
    vi.doMock(CLIENT_PATH, () => ({
      ChatwootApiClient: class { createNote = mockCreateNote; },
      ChatwootApiError: class extends Error {},
    }));

    const { postEscalateNote } = await import(HANDLER_PATH);
    const client = createMockClient(99);

    await expect(
      postEscalateNote(client as never, 'prod', 'conv-uuid-1', escalateAction),
    ).resolves.toBeUndefined();
  });

  it('formata nota com rótulos corretos para cada reason', async () => {
    process.env.CHATWOOT_API_BASE_URL = 'http://chatwoot.test/api/v1';
    process.env.CHATWOOT_API_TOKEN = 'token-test';
    process.env.CHATWOOT_ACCOUNT_ID = '1';

    const bodies: string[] = [];
    vi.doMock(CLIENT_PATH, () => ({
      ChatwootApiClient: class {
        createNote = vi.fn().mockImplementation((_id: number, body: string) => {
          bodies.push(body);
          return Promise.resolve();
        });
      },
      ChatwootApiError: class extends Error {},
    }));

    const { postEscalateNote } = await import(HANDLER_PATH);
    const client = createMockClient(1);

    await postEscalateNote(client as never, 'prod', 'c1', {
      type: 'escalate',
      reason: 'ready_to_close',
      summary_text: 'Pronto',
    });
    await postEscalateNote(client as never, 'prod', 'c2', {
      type: 'escalate',
      reason: 'validator_blocked',
      summary_text: 'Bloqueado',
    });

    expect(bodies[0]).toContain('Pronto para fechar');
    expect(bodies[1]).toContain('Bot bloqueado por validação');
  });
});

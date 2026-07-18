import { afterEach, describe, expect, it, vi } from 'vitest';

const baseEnv = {
  NODE_ENV: 'test',
  FAREJADOR_ENV: 'prod',
  DATABASE_URL: 'postgresql://postgres:password@example.test:6543/postgres',
  CHATWOOT_HMAC_SECRET: 'test-secret',
  ADMIN_AUTH_TOKEN: 'test-admin-token',
};

async function loadSender(extraEnv: Record<string, string> = {}) {
  vi.resetModules();
  Object.assign(process.env, baseEnv, extraEnv);
  vi.doMock('pino', () => ({
    default: vi.fn(() => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  }));
  return import('../../../src/atendente-v2/sender.js');
}

describe('agent_v2 sender', () => {
  afterEach(() => {
    vi.doUnmock('pino');
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('does not fail open when Chatwoot API config is missing', async () => {
    const { sendMessage } = await loadSender();

    await expect(sendMessage(123, 'oi')).rejects.toThrow('Chatwoot API configuration is missing');
  });

  it('returns the Chatwoot message id from the API response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 987 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { sendMessage } = await loadSender({
      CHATWOOT_API_BASE_URL: 'https://chatwoot.example.test/api/v1',
      CHATWOOT_API_TOKEN: 'secret-token-value',
      CHATWOOT_ACCOUNT_ID: '1',
    });

    const result = await sendMessage(123, 'oi', 'turn-abc');

    expect(result).toEqual({ chatwootMessageId: 987 });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.echo_id).toBe('turn-abc');
    expect(body.private).toBe(false);
  });

  it('does not retry an ambiguous POST inside memory when used by the outbox', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('fetch failed after write'));
    vi.stubGlobal('fetch', fetchMock);
    const { sendMessageOnce } = await loadSender({
      CHATWOOT_API_BASE_URL: 'https://chatwoot.example.test/api/v1',
      CHATWOOT_API_TOKEN: 'secret-token-value',
      CHATWOOT_ACCOUNT_ID: '1',
    });

    await expect(sendMessageOnce(123, 'oi', 'turn-abc')).rejects.toThrow('fetch failed after write');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('marks an ambiguous attachment POST for human review without an in-memory retry', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('attachment result unknown'));
    vi.stubGlobal('fetch', fetchMock);
    const { sendAttachmentOnce } = await loadSender({
      CHATWOOT_API_BASE_URL: 'https://chatwoot.example.test/api/v1',
      CHATWOOT_API_TOKEN: 'secret-token-value', CHATWOOT_ACCOUNT_ID: '1',
    });

    await expect(sendAttachmentOnce(123, {
      buffer: Buffer.from('image'), filename: 'pneu.jpg', contentType: 'image/jpeg',
    }, 'foto')).rejects.toMatchObject({ status: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

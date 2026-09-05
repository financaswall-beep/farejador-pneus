import { afterEach, describe, expect, it, vi } from 'vitest';

const baseEnv = {
  NODE_ENV: 'test',
  FAREJADOR_ENV: 'prod',
  DATABASE_URL: 'postgresql://postgres:password@example.test:6543/postgres',
  CHATWOOT_HMAC_SECRET: 'test-secret',
  ADMIN_AUTH_TOKEN: 'test-admin-token',
  BOT_OUTBOX: 'false',
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

  it('blocks direct sending when the durable outbox is disabled', async () => {
    const { sendMessage } = await loadSender();

    await expect(sendMessage(123, 'oi')).rejects.toThrow('Direct bot sending is disabled');
  });

  it('blocks the single-attempt outbox sender when BOT_OUTBOX is disabled', async () => {
    const { sendMessageOnce } = await loadSender();

    await expect(sendMessageOnce(123, 'não deve sair'))
      .rejects.toThrow('Bot outbox delivery is disabled');
  });

  it('returns the Chatwoot message id from the API response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 987 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { sendMessage } = await loadSender({
      CHATWOOT_API_BASE_URL: 'https://chatwoot.example.test/api/v1',
      CHATWOOT_API_TOKEN: 'secret-token-value',
      CHATWOOT_ACCOUNT_ID: '1',
      BOT_OUTBOX: 'true',
    });

    const result = await sendMessage(123, 'oi', 'turn-abc');

    expect(result).toEqual({ chatwootMessageId: 987 });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.echo_id).toBe('turn-abc');
    expect(body.content_attributes).toEqual({ farejador_echo_id:'turn-abc' });
    expect(body.private).toBe(false);
  });

  it('does not retry an ambiguous POST inside memory when used by the outbox', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('fetch failed after write'));
    vi.stubGlobal('fetch', fetchMock);
    const { sendMessageOnce } = await loadSender({
      CHATWOOT_API_BASE_URL: 'https://chatwoot.example.test/api/v1',
      CHATWOOT_API_TOKEN: 'secret-token-value',
      CHATWOOT_ACCOUNT_ID: '1',
      BOT_OUTBOX: 'true',
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
      BOT_OUTBOX: 'true',
    });

    await expect(sendAttachmentOnce(123, {
      buffer: Buffer.from('image'), filename: 'pneu.jpg', contentType: 'image/jpeg',
    }, 'foto')).rejects.toMatchObject({ status: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('correlaciona anexos da outbox sem acrescentar aviso ao texto público', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id:987 })));
    vi.stubGlobal('fetch',fetchMock);
    const { sendAttachmentOnce } = await loadSender({
      CHATWOOT_API_BASE_URL:'https://chatwoot.example.test/api/v1',CHATWOOT_API_TOKEN:'test-token',
      CHATWOOT_ACCOUNT_ID:'2',BOT_OUTBOX:'true',
    });
    await sendAttachmentOnce(123,{ buffer:Buffer.from('image'),filename:'pneu.jpg',contentType:'image/jpeg' },
      'Foto solicitada','photo:request-1');
    const form = fetchMock.mock.calls[0][1].body as FormData;
    expect(form.get('content')).toBe('Foto solicitada');
    expect(form.get('echo_id')).toBe('photo:request-1');
    expect(JSON.parse(String(form.get('content_attributes')))).toEqual({ farejador_echo_id:'photo:request-1' });
  });
});

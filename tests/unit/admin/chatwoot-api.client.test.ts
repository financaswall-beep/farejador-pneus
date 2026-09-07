import { afterEach, describe, expect, it, vi } from 'vitest';

const baseEnv = {
  NODE_ENV: 'test',
  FAREJADOR_ENV: 'prod',
  DATABASE_URL: 'postgresql://postgres:password@example.test:6543/postgres',
  CHATWOOT_HMAC_SECRET: 'test-secret',
  ADMIN_AUTH_TOKEN: 'test-admin-token',
};

async function loadClient() {
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

  return import('../../../src/admin/chatwoot-api.client.js');
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('ChatwootApiClient', () => {
  afterEach(() => {
    vi.doUnmock('pino');
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.resetModules();
  });

  it('returns parsed payload from a valid 200 response', async () => {
    const { ChatwootApiClient } = await loadClient();
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          payload: [{ id: 123, updated_at: '2026-04-24T12:00:00Z' }],
          meta: { all_count: 1, per_page: 25 },
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new ChatwootApiClient({
      baseUrl: 'https://chatwoot.example.test/api/v1',
      accountId: 1,
      apiToken: 'secret-token-value',
    });

    const page = await client.listConversations({
      since: new Date('2026-04-20T00:00:00Z'),
      until: new Date('2026-04-24T00:00:00Z'),
      page: 1,
    });

    expect(page.items).toEqual([{ id: 123, updated_at: '2026-04-24T12:00:00Z' }]);
    expect(page.hasMore).toBe(false);
    const requestedUrl = fetchMock.mock.calls[0]?.[0] as URL;
    expect(requestedUrl.searchParams.get('status')).toBe('all');
    expect(requestedUrl.searchParams.has('q[updated_at_gteq]')).toBe(false);
  });

  it('retries 5xx responses up to 3 attempts and then throws', async () => {
    const { ChatwootApiClient, ChatwootApiError } = await loadClient();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'server unavailable' }, 500));
    const client = new ChatwootApiClient({
      baseUrl: 'https://chatwoot.example.test/api/v1',
      accountId: 1,
      apiToken: 'secret-token-value',
      fetchFn: fetchMock as typeof fetch,
      sleepFn: vi.fn().mockResolvedValue(undefined),
    });

    await expect(
      client.listConversations({
        since: new Date('2026-04-20T00:00:00Z'),
        until: new Date('2026-04-24T00:00:00Z'),
        page: 1,
      }),
    ).rejects.toBeInstanceOf(ChatwootApiError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries 429 responses with backoff', async () => {
    const { ChatwootApiClient } = await loadClient();
    const sleepMock = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'rate limited' }, 429))
      .mockResolvedValueOnce(
        jsonResponse({
          data: { payload: [], meta: { all_count: 0, per_page: 25 } },
        }),
      );
    const client = new ChatwootApiClient({
      baseUrl: 'https://chatwoot.example.test/api/v1',
      accountId: 1,
      apiToken: 'secret-token-value',
      fetchFn: fetchMock as typeof fetch,
      sleepFn: sleepMock,
    });

    await client.listConversations({
      since: new Date('2026-04-20T00:00:00Z'),
      until: new Date('2026-04-24T00:00:00Z'),
      page: 1,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenCalledWith(500);
  });

  it('does not retry non-retriable 4xx responses', async () => {
    const { ChatwootApiClient, ChatwootApiError } = await loadClient();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'not found' }, 404));
    const client = new ChatwootApiClient({
      baseUrl: 'https://chatwoot.example.test/api/v1',
      accountId: 1,
      apiToken: 'secret-token-value',
      fetchFn: fetchMock as typeof fetch,
      sleepFn: vi.fn().mockResolvedValue(undefined),
    });

    await expect(client.listMessages({ conversationId: 123, page: 1 })).rejects.toBeInstanceOf(
      ChatwootApiError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aborts a request after the 10s timeout', async () => {
    const { ChatwootApiClient, ChatwootApiError } = await loadClient();
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: URL | RequestInfo, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });
    const client = new ChatwootApiClient({
      baseUrl: 'https://chatwoot.example.test/api/v1',
      accountId: 1,
      apiToken: 'secret-token-value',
      fetchFn: fetchMock as typeof fetch,
      sleepFn: vi.fn().mockResolvedValue(undefined),
    });

    const promise = client.listMessages({ conversationId: 123, page: 1 });
    const expectation = expect(promise).rejects.toBeInstanceOf(ChatwootApiError);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);

    await expectation;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not include the API token in thrown errors', async () => {
    const { ChatwootApiClient } = await loadClient();
    const token = 'super-secret-chatwoot-token-value';
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: token }, 401));
    const client = new ChatwootApiClient({
      baseUrl: 'https://chatwoot.example.test/api/v1',
      accountId: 1,
      apiToken: token,
      fetchFn: fetchMock as typeof fetch,
    });

    await expect(client.listMessages({ conversationId: 123, page: 1 })).rejects.not.toThrow(token);
  });

  it('sets hasMore when all_count is greater than page times per_page', async () => {
    const { ChatwootApiClient } = await loadClient();
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          payload: [{ id: 1 }, { id: 2 }],
          meta: { all_count: 5, per_page: 2 },
        },
      }),
    );
    const client = new ChatwootApiClient({
      baseUrl: 'https://chatwoot.example.test/api/v1',
      accountId: 1,
      apiToken: 'secret-token-value',
      fetchFn: fetchMock as typeof fetch,
    });

    const page = await client.listMessages({ conversationId: 123, page: 1 });

    expect(page.hasMore).toBe(true);
  });

  it('accepts top-level payload responses used by Chatwoot messages API', async () => {
    const { ChatwootApiClient } = await loadClient();
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        payload: [{ id: 18, conversation_id: 8, created_at: 1777148517 }],
        meta: {},
      }),
    );
    const client = new ChatwootApiClient({
      baseUrl: 'https://chatwoot.example.test/api/v1',
      accountId: 1,
      apiToken: 'secret-token-value',
      fetchFn: fetchMock as typeof fetch,
    });

    const page = await client.listMessages({ conversationId: 8, page: 1 });

    expect(page.items).toEqual([{ id: 18, conversation_id: 8, created_at: 1777148517 }]);
    expect(page.hasMore).toBe(false);
  });

  it('define resolved explicitamente sem enviar mensagem ao cliente', async () => {
    const { ChatwootApiClient } = await loadClient();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true }));
    const client = new ChatwootApiClient({
      baseUrl: 'https://chatwoot.example.test/api/v1', accountId: 2,
      apiToken: 'secret-token-value', fetchFn: fetchMock as typeof fetch, maxPostAttempts: 1,
    });
    await client.setConversationStatus(39, 'resolved');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/accounts/2/conversations/39/toggle_status');
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)))
      .toEqual({ status: 'resolved' });
  });

  it('lê a agenda comercial do inbox', async () => {
    const { ChatwootApiClient } = await loadClient();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      id: 39, working_hours_enabled: true, timezone: 'America/Sao_Paulo',
      working_hours: [
        { day_of_week: 1, closed_all_day: false, open_all_day: false,
          open_hour: 9, open_minutes: 0, close_hour: 18, close_minutes: 0 },
        { day_of_week: 6, closed_all_day: true, open_all_day: false,
          open_hour: null, open_minutes: null, close_hour: null, close_minutes: null },
      ],
    }));
    const client = new ChatwootApiClient({
      baseUrl: 'https://chatwoot.example.test/api/v1', accountId: 2,
      apiToken: 'secret-token-value', fetchFn: fetchMock as typeof fetch,
    });
    await expect(client.getInbox(39)).resolves.toMatchObject({
      id: 39, workingHoursEnabled: true, timezone: 'America/Sao_Paulo',
      workingHours: [
        { dayOfWeek: 1, openHour: 9, closeHour: 18 },
        { dayOfWeek: 6, closedAllDay: true, openHour: 0, closeHour: 0 },
      ],
    });
  });

  it('aceita horários nulos enviados pelo Chatwoot em dias fechados', async () => {
    const { ChatwootApiClient } = await loadClient();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      id: 39, working_hours_enabled: false, timezone: 'America/Sao_Paulo',
      working_hours: [
        { day_of_week: 0, closed_all_day: true, open_all_day: false,
          open_hour: null, open_minutes: null, close_hour: null, close_minutes: null },
        { day_of_week: 6, closed_all_day: true, open_all_day: false,
          open_hour: null, open_minutes: null, close_hour: null, close_minutes: null },
      ],
    }));
    const client = new ChatwootApiClient({
      baseUrl: 'https://chatwoot.example.test/api/v1', accountId: 2,
      apiToken: 'secret-token-value', fetchFn: fetchMock as typeof fetch,
    });

    await expect(client.getInbox(39)).resolves.toMatchObject({
      workingHoursEnabled: false,
      workingHours: [
        { dayOfWeek: 0, closedAllDay: true, openHour: 0, closeHour: 0 },
        { dayOfWeek: 6, closedAllDay: true, openHour: 0, closeHour: 0 },
      ],
    });
  });

  it('rejeita horário nulo em dia aberto quando a agenda está habilitada', async () => {
    const { ChatwootApiClient } = await loadClient();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      id: 39, working_hours_enabled: true, timezone: 'America/Sao_Paulo',
      working_hours: [{ day_of_week: 1, closed_all_day: false, open_all_day: false,
        open_hour: null, open_minutes: null, close_hour: null, close_minutes: null }],
    }));
    const client = new ChatwootApiClient({
      baseUrl: 'https://chatwoot.example.test/api/v1', accountId: 2,
      apiToken: 'secret-token-value', fetchFn: fetchMock as typeof fetch,
    });

    await expect(client.getInbox(39)).rejects.toThrow('required for an open business day');
  });
});

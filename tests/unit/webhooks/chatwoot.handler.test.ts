import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';

const baseEnv = {
  NODE_ENV: 'test',
  FAREJADOR_ENV: 'prod',
  DATABASE_URL: 'postgresql://postgres:password@example.test:6543/postgres',
  CHATWOOT_HMAC_SECRET: 'test-secret',
  CHATWOOT_WEBHOOK_MAX_AGE_SECONDS: '300',
  ADMIN_AUTH_TOKEN: 'test-admin-token',
};

interface MockClient {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

interface RequestOptions {
  deliveryId?: string;
  signatureOverride?: string;
  timestamp?: string;
  omitTimestamp?: boolean;
}

function createReply(): FastifyReply {
  const reply = {
    statusCode: 200,
    payload: undefined as unknown,
    status: vi.fn(function status(this: typeof reply, code: number) {
      this.statusCode = code;
      return this;
    }),
    send: vi.fn(function send(this: typeof reply, payload: unknown) {
      this.payload = payload;
      return this;
    }),
  };

  return reply as unknown as FastifyReply;
}

function createRequest(payload: unknown, options: RequestOptions = {}): FastifyRequest {
  const raw = Buffer.from(JSON.stringify(payload));
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signedPayload = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), raw]);
  const signature = options.signatureOverride
    ?? createHmac('sha256', baseEnv.CHATWOOT_HMAC_SECRET).update(signedPayload).digest('hex');
  const headers: Record<string, string> = {
    'x-chatwoot-signature': signature,
    'x-chatwoot-delivery': options.deliveryId ?? 'delivery-1',
  };

  if (!options.omitTimestamp) {
    headers['x-chatwoot-timestamp'] = timestamp;
  }

  return {
    body: payload,
    raw: { rawBody: raw },
    headers,
  } as unknown as FastifyRequest;
}

async function loadHandler(clientOrError: MockClient | Error): Promise<{
  handler: typeof import('../../../src/webhooks/chatwoot.handler').chatwootWebhookHandler;
  connect: ReturnType<typeof vi.fn>;
}> {
  vi.resetModules();
  Object.assign(process.env, baseEnv);

  const connect = clientOrError instanceof Error
    ? vi.fn().mockRejectedValue(clientOrError)
    : vi.fn().mockResolvedValue(clientOrError);
  vi.doMock('pino', () => ({
    default: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  }));
  vi.doMock('pg', () => ({
    Pool: vi.fn(function Pool() {
      return { connect, on: vi.fn(), end: vi.fn() };
    }),
  }));

  const module = await import('../../../src/webhooks/chatwoot.handler');
  return { handler: module.chatwootWebhookHandler, connect };
}

describe('chatwootWebhookHandler', () => {
  afterEach(() => {
    vi.doUnmock('pg');
    vi.doUnmock('pino');
    vi.resetModules();
  });

  it('persists a valid webhook as pending raw event', async () => {
    const client: MockClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 123 }] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    };
    const { handler } = await loadHandler(client);
    const reply = createReply();

    await handler(
      createRequest({ event: 'message_created', account: { id: 1 }, id: 1001 }),
      reply,
    );

    expect(reply.statusCode).toBe(200);
    expect(reply.payload).toEqual({ received: true, delivery_id: 'delivery-1' });
    expect(client.query).toHaveBeenCalledWith('BEGIN');
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('persists a valid webhook when the server parser returns normal JSON body', async () => {
    const client: MockClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 456 }] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    };
    const { handler } = await loadHandler(client);
    const reply = createReply();

    await handler(
      createRequest({ event: 'message_created', account: { id: 1 }, id: 1002 }, { deliveryId: 'delivery-parsed-body' }),
      reply,
    );

    expect(reply.statusCode).toBe(200);
    expect(reply.payload).toEqual({ received: true, delivery_id: 'delivery-parsed-body' });
    expect(client.query).toHaveBeenCalledWith('BEGIN');
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('returns 200 for duplicate deliveries without inserting raw event', async () => {
    const client: MockClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    };
    const { handler } = await loadHandler(client);
    const reply = createReply();

    await handler(
      createRequest({ event: 'message_created', account: { id: 1 }, id: 1001 }),
      reply,
    );

    expect(reply.statusCode).toBe(200);
    expect(client.query).toHaveBeenCalledTimes(3);
    expect(client.query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('rejects invalid signatures before touching the database', async () => {
    const client: MockClient = { query: vi.fn(), release: vi.fn() };
    const { handler, connect } = await loadHandler(client);
    const reply = createReply();

    await handler(
      createRequest(
        { event: 'message_created', account: { id: 1 }, id: 1001 },
        { signatureOverride: '0'.repeat(64) },
      ),
      reply,
    );

    expect(reply.statusCode).toBe(401);
    expect(connect).not.toHaveBeenCalled();
  });

  it('rejects missing timestamps before touching the database', async () => {
    const client: MockClient = { query: vi.fn(), release: vi.fn() };
    const { handler, connect } = await loadHandler(client);
    const reply = createReply();

    await handler(
      createRequest(
        { event: 'message_created', account: { id: 1 }, id: 1001 },
        { omitTimestamp: true },
      ),
      reply,
    );

    expect(reply.statusCode).toBe(401);
    expect(connect).not.toHaveBeenCalled();
  });

  it('rejects expired timestamps before touching the database', async () => {
    const client: MockClient = { query: vi.fn(), release: vi.fn() };
    const { handler, connect } = await loadHandler(client);
    const reply = createReply();

    await handler(
      createRequest(
        { event: 'message_created', account: { id: 1 }, id: 1001 },
        { timestamp: '1' },
      ),
      reply,
    );

    expect(reply.statusCode).toBe(401);
    expect(connect).not.toHaveBeenCalled();
  });

  it('rejects invalid payloads before touching the database', async () => {
    const client: MockClient = { query: vi.fn(), release: vi.fn() };
    const { handler, connect } = await loadHandler(client);
    const reply = createReply();

    await handler(createRequest({ account: { id: 1 }, id: 1001 }), reply);

    expect(reply.statusCode).toBe(400);
    expect(connect).not.toHaveBeenCalled();
  });

  it('returns 500 and rolls back when raw persistence fails', async () => {
    const client: MockClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockRejectedValueOnce(new Error('insert failed'))
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    };
    const { handler } = await loadHandler(client);
    const reply = createReply();

    await handler(
      createRequest({ event: 'message_created', account: { id: 1 }, id: 1001 }),
      reply,
    );

    expect(reply.statusCode).toBe(500);
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('returns 500 when the database connection fails', async () => {
    const { handler, connect } = await loadHandler(new Error('connect failed'));
    const reply = createReply();

    await handler(
      createRequest({ event: 'message_created', account: { id: 1 }, id: 1001 }),
      reply,
    );

    expect(reply.statusCode).toBe(500);
    expect(connect).toHaveBeenCalledOnce();
  });
});

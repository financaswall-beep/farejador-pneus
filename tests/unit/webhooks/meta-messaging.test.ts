import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { validateMetaMessagingSignature } from '../../../src/webhooks/meta-messaging.hmac.js';

const baseEnv = {
  NODE_ENV: 'test',
  FAREJADOR_ENV: 'test',
  DATABASE_URL: 'postgresql://postgres:password@example.test:6543/postgres',
  CHATWOOT_HMAC_SECRET: 'chatwoot-test-secret',
  ADMIN_AUTH_TOKEN: 'test-admin-token',
  META_MESSAGING_WEBHOOK_ENABLED: 'true',
  META_MESSAGING_WEBHOOK_VERIFY_TOKEN: 'verify-meta-123',
  META_APP_SECRET: 'meta-app-secret-123',
};

function replyMock(): FastifyReply {
  const reply = {
    statusCode: 200,
    payload: undefined as unknown,
    status: vi.fn(function status(this: typeof reply, code: number) { this.statusCode = code; return this; }),
    type: vi.fn(function type(this: typeof reply) { return this; }),
    send: vi.fn(function send(this: typeof reply, payload: unknown) { this.payload = payload; return this; }),
  };
  return reply as unknown as FastifyReply;
}

describe('webhook Meta messaging', () => {
  beforeEach(() => {
    vi.resetModules();
    Object.assign(process.env, baseEnv);
  });

  afterEach(() => {
    vi.doUnmock('pg');
    vi.resetModules();
  });

  it('valida X-Hub-Signature-256 sobre o corpo bruto', () => {
    const body = Buffer.from('{"object":"page"}');
    const signature = createHmac('sha256', baseEnv.META_APP_SECRET).update(body).digest('hex');
    expect(validateMetaMessagingSignature(body, `sha256=${signature}`, baseEnv.META_APP_SECRET))
      .toBe(true);
    expect(validateMetaMessagingSignature(body, `sha256=${'0'.repeat(64)}`, baseEnv.META_APP_SECRET))
      .toBe(false);
  });

  it('só devolve o challenge com o verify token correto', async () => {
    const { metaMessagingVerifyHandler } = await import('../../../src/webhooks/meta-messaging.handler.js');
    const ok = replyMock();
    await metaMessagingVerifyHandler({
      query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-meta-123', 'hub.challenge': '42' },
    } as unknown as FastifyRequest<any>, ok);
    expect(ok.statusCode).toBe(200);
    expect((ok as any).payload).toBe('42');

    const denied = replyMock();
    await metaMessagingVerifyHandler({
      query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'errado', 'hub.challenge': '42' },
    } as unknown as FastifyRequest<any>, denied);
    expect(denied.statusCode).toBe(403);
  });

  it('persiste o evento bruto antes do 200 e agenda o processamento', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('INSERT INTO raw.meta_messaging_events')) {
        return { rows: [{ id: 91 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const release = vi.fn();
    const connect = vi.fn().mockResolvedValue({ query, release });
    vi.doMock('pg', () => ({
      Pool: vi.fn(() => ({ connect, on: vi.fn(), end: vi.fn() })),
    }));
    const { metaMessagingWebhookHandler } = await import('../../../src/webhooks/meta-messaging.handler.js');
    const payload = { object: 'page', entry: [] };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const signature = createHmac('sha256', baseEnv.META_APP_SECRET).update(rawBody).digest('hex');
    const reply = replyMock();

    await metaMessagingWebhookHandler({
      body: payload,
      raw: { rawBody },
      headers: { 'x-hub-signature-256': `sha256=${signature}` },
    } as unknown as FastifyRequest, reply);

    expect(reply.statusCode).toBe(200);
    expect(query.mock.calls.map(([sql]) => String(sql))).toEqual(expect.arrayContaining([
      'BEGIN',
      expect.stringContaining('INSERT INTO raw.meta_messaging_events'),
      expect.stringContaining("pg_notify('meta_messaging_events_new'"),
      'COMMIT',
    ]));
    expect(release).toHaveBeenCalledOnce();
  });

  it('rejeita assinatura inválida sem tocar no banco', async () => {
    const connect = vi.fn();
    vi.doMock('pg', () => ({
      Pool: vi.fn(() => ({ connect, on: vi.fn(), end: vi.fn() })),
    }));
    const { metaMessagingWebhookHandler } = await import('../../../src/webhooks/meta-messaging.handler.js');
    const payload = { object: 'instagram', entry: [] };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const reply = replyMock();

    await metaMessagingWebhookHandler({
      body: payload,
      raw: { rawBody },
      headers: { 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` },
    } as unknown as FastifyRequest, reply);

    expect(reply.statusCode).toBe(401);
    expect(connect).not.toHaveBeenCalled();
  });
});

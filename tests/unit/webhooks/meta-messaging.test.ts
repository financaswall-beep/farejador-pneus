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
  META_COMMENTS_ENABLED: 'false',
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
      Pool: vi.fn(function Pool() { return { connect, on: vi.fn(), end: vi.fn() }; }),
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
      Pool: vi.fn(function Pool() { return { connect, on: vi.fn(), end: vi.fn() }; }),
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

  it.each([false,true])('captura comentário com messaging desligado e respeita duplicação: %s',async(duplicate)=>{
    Object.assign(process.env,{META_MESSAGING_WEBHOOK_ENABLED:'false',META_COMMENTS_ENABLED:'true',META_COMMENTS_PAGE_ID:'1434857906367394',META_COMMENTS_INSTAGRAM_ID:'17841465774227389'});
    const query=vi.fn(async(sql:string)=>({rows:sql.includes('INSERT INTO raw.meta_messaging_events')&&!duplicate?[{id:92}]:[],rowCount:1}));
    vi.doMock('pg',()=>({Pool:vi.fn(function Pool(){return {connect:async()=>({query,release:vi.fn()}),on:vi.fn(),end:vi.fn()};})}));
    const {metaMessagingWebhookHandler,metaMessagingVerifyHandler}=await import('../../../src/webhooks/meta-messaging.handler.js');
    const verify=replyMock();
    await metaMessagingVerifyHandler({query:{'hub.mode':'subscribe','hub.verify_token':baseEnv.META_MESSAGING_WEBHOOK_VERIFY_TOKEN,'hub.challenge':'42'}} as any,verify);
    expect(verify.statusCode).toBe(200);
    const payload={object:'page',entry:[{id:'1434857906367394',time:1770000000,changes:[{field:'feed',value:{item:'comment',verb:'add',post_id:'1434857906367394_80',comment_id:'1434857906367394_1',message:'Oi',from:{id:'300'}}}]}]};
    const rawBody=Buffer.from(JSON.stringify(payload));
    const signature=createHmac('sha256',baseEnv.META_APP_SECRET).update(rawBody).digest('hex');
    const reply=replyMock();
    await metaMessagingWebhookHandler({body:payload,raw:{rawBody},headers:{'x-hub-signature-256':`sha256=${signature}`}} as any,reply);
    expect(reply.statusCode).toBe(200);
    const writes=query.mock.calls.map(([sql])=>sql);
    expect(writes.some(sql=>sql.includes('INSERT INTO ops.meta_comment_events'))).toBe(!duplicate);
    expect(writes.at(-1)).toBe('COMMIT');
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MappedMessage } from '../../../src/normalization/message.mapper.js';

const baseEnv = {
  NODE_ENV: 'test',
  FAREJADOR_ENV: 'prod',
  DATABASE_URL: 'postgresql://postgres:password@example.test:6543/postgres',
  CHATWOOT_HMAC_SECRET: 'test-secret',
  CHATWOOT_WEBHOOK_MAX_AGE_SECONDS: '300',
  ADMIN_AUTH_TOKEN: 'test-admin-token',
  AGENT_V2_WORKER_ENABLED: 'false',
};

interface QueryCall {
  sql: string;
  params: unknown[];
}

interface MockOpts {
  hasUnit?: boolean;
  echoClaims?: boolean;
  messageInserted?: boolean;
}

function createMockClient(calls: QueryCall[], opts: MockOpts = {}) {
  const { hasUnit = true, echoClaims = false, messageInserted = true } = opts;
  return {
    query: vi.fn().mockImplementation((sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('FROM network.partner_units')) {
        return Promise.resolve({ rowCount: hasUnit ? 1 : 0, rows: hasUnit ? [{ unit_id: 'unit-1' }] : [] });
      }
      if (sql.includes('INSERT INTO commerce.partner_conversations')) {
        return Promise.resolve({ rowCount: 1, rows: [{ id: 'conv-1' }] });
      }
      if (sql.includes('UPDATE commerce.partner_messages')) {
        return Promise.resolve({ rowCount: echoClaims ? 1 : 0, rows: [] });
      }
      if (sql.includes('INSERT INTO commerce.partner_messages')) {
        return Promise.resolve({ rowCount: messageInserted ? 1 : 0, rows: messageInserted ? [{ id: 'msg-1' }] : [] });
      }
      return Promise.resolve({ rowCount: 0, rows: [] });
    }),
  };
}

function makeMessage(overrides: Partial<MappedMessage> = {}): MappedMessage {
  return {
    environment: 'prod',
    chatwootMessageId: 555,
    chatwootAccountId: 2,
    chatwootInboxId: 1,
    chatwootConversationId: 99,
    senderType: 'contact',
    senderId: 7,
    messageType: 0,
    content: 'Boa tarde, tem 90/90-18?',
    contentType: 'text',
    contentAttributes: {},
    isPrivate: false,
    status: null,
    externalSourceIds: null,
    echoId: null,
    sentAt: new Date('2026-05-29T17:00:00Z'),
    lastEventAt: new Date('2026-05-29T17:00:00Z'),
    ...overrides,
  };
}

const rawWhatsapp = {
  conversation: {
    id: 99,
    channel: 'Channel::Whatsapp',
    meta: { sender: { name: 'Carlos Henrique', phone_number: '+5511987654321' } },
  },
};

function findCall(calls: QueryCall[], needle: string): QueryCall | undefined {
  return calls.find((c) => c.sql.includes(needle));
}

describe('partner chat fanout', () => {
  beforeEach(() => {
    vi.resetModules();
    Object.assign(process.env, baseEnv, { PARTNER_CHAT_FANOUT_ENABLED: 'true' });
    vi.doMock('pino', () => ({
      default: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
    }));
  });

  afterEach(() => {
    vi.doUnmock('pino');
    vi.resetModules();
    delete process.env.PARTNER_CHAT_FANOUT_ENABLED;
  });

  async function load() {
    return (await import('../../../src/normalization/partner-chat.fanout.js')).fanOutMessageToPartnerChat;
  }

  it('does nothing when the flag is off', async () => {
    process.env.PARTNER_CHAT_FANOUT_ENABLED = 'false';
    const fanOut = await load();
    const calls: QueryCall[] = [];
    const client = createMockClient(calls);
    await fanOut(client as never, makeMessage(), rawWhatsapp);
    expect(client.query).not.toHaveBeenCalled();
  });

  it('skips internal private notes', async () => {
    const fanOut = await load();
    const calls: QueryCall[] = [];
    const client = createMockClient(calls);
    await fanOut(client as never, makeMessage({ isPrivate: true }), rawWhatsapp);
    expect(client.query).not.toHaveBeenCalled();
  });

  it('skips activity messages and empty content', async () => {
    const fanOut = await load();
    const calls: QueryCall[] = [];
    const client = createMockClient(calls);
    await fanOut(client as never, makeMessage({ messageType: 2 }), rawWhatsapp);
    await fanOut(client as never, makeMessage({ content: '   ' }), rawWhatsapp);
    expect(client.query).not.toHaveBeenCalled();
  });

  it('records an inbound customer message and bumps unread', async () => {
    const fanOut = await load();
    const calls: QueryCall[] = [];
    const client = createMockClient(calls);
    await fanOut(client as never, makeMessage(), rawWhatsapp);

    const msgInsert = findCall(calls, 'INSERT INTO commerce.partner_messages');
    expect(msgInsert).toBeDefined();
    // params: env, unit_id, conv_id, chatwoot_message_id, direction, sender, content
    expect(msgInsert!.params[4]).toBe('inbound');
    expect(msgInsert!.params[5]).toBe('customer');

    const convUpsert = findCall(calls, 'INSERT INTO commerce.partner_conversations');
    expect(convUpsert!.params[3]).toBe('whatsapp'); // canal derivado
    expect(convUpsert!.params[4]).toBe('Carlos Henrique');

    const unreadUpdate = findCall(calls, 'UPDATE commerce.partner_conversations');
    expect(unreadUpdate!.params[2]).toBe(1); // unreadDelta = 1 (inbound)
  });

  it('labels outgoing bot messages as bot and human as partner', async () => {
    const fanOut = await load();

    const botCalls: QueryCall[] = [];
    const botClient = createMockClient(botCalls);
    await fanOut(botClient as never, makeMessage({ messageType: 1, senderType: 'agent_bot' }), rawWhatsapp);
    expect(findCall(botCalls, 'INSERT INTO commerce.partner_messages')!.params[5]).toBe('bot');
    expect(findCall(botCalls, 'UPDATE commerce.partner_conversations')!.params[2]).toBe(0); // outbound não conta unread

    const humanCalls: QueryCall[] = [];
    const humanClient = createMockClient(humanCalls);
    await fanOut(humanClient as never, makeMessage({ messageType: 1, senderType: 'user' }), rawWhatsapp);
    expect(findCall(humanCalls, 'INSERT INTO commerce.partner_messages')!.params[5]).toBe('partner');
  });

  it('skips when there is no single active partner unit', async () => {
    const fanOut = await load();
    const calls: QueryCall[] = [];
    const client = createMockClient(calls, { hasUnit: false });
    await fanOut(client as never, makeMessage(), rawWhatsapp);
    expect(findCall(calls, 'INSERT INTO commerce.partner_conversations')).toBeUndefined();
    expect(findCall(calls, 'RELEASE SAVEPOINT')).toBeDefined();
  });

  it('claims the optimistic outbound row on echo and does not reinsert', async () => {
    const fanOut = await load();
    const calls: QueryCall[] = [];
    const client = createMockClient(calls, { echoClaims: true });
    await fanOut(
      client as never,
      makeMessage({ messageType: 1, senderType: 'user', echoId: 'tok-abc' }),
      rawWhatsapp,
    );
    const claim = findCall(calls, 'UPDATE commerce.partner_messages');
    expect(claim).toBeDefined();
    expect(claim!.params[2]).toBe('tok-abc'); // client_token = echo_id
    expect(findCall(calls, 'INSERT INTO commerce.partner_messages')).toBeUndefined();
  });

  it('derives instagram and facebook channels', async () => {
    const fanOut = await load();

    const ig: QueryCall[] = [];
    await fanOut(createMockClient(ig) as never, makeMessage(), {
      conversation: { id: 1, channel: 'Channel::Instagram' },
    });
    expect(findCall(ig, 'INSERT INTO commerce.partner_conversations')!.params[3]).toBe('instagram');

    const fb: QueryCall[] = [];
    await fanOut(createMockClient(fb) as never, makeMessage(), {
      conversation: { id: 1, additional_attributes: { channel_type: 'Channel::FacebookPage' } },
    });
    expect(findCall(fb, 'INSERT INTO commerce.partner_conversations')!.params[3]).toBe('facebook');
  });
});

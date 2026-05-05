import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const baseEnv = {
  NODE_ENV: 'test',
  FAREJADOR_ENV: 'prod',
  DATABASE_URL: 'postgresql://postgres:password@example.test:6543/postgres',
  CHATWOOT_HMAC_SECRET: 'test-secret',
  CHATWOOT_WEBHOOK_MAX_AGE_SECONDS: '300',
  ADMIN_AUTH_TOKEN: 'test-admin-token',
  ORGANIZADORA_ENABLED: 'false',
  ATENDENTE_SHADOW_ENABLED: 'false',
};

function createMockClient(): {
  query: ReturnType<typeof vi.fn>;
} {
  return {
    query: vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('ops.enqueue_enrichment_job')) {
        return Promise.resolve({
          rows: [{ enqueue_enrichment_job: 'job-uuid-1' }],
        });
      }
      if (sql.includes('ops.enqueue_atendente_job')) {
        return Promise.resolve({
          rows: [{ enqueue_atendente_job: 'atendente-job-uuid-1' }],
        });
      }
      if (sql.includes('INSERT INTO agent.session_current')) {
        return Promise.resolve({
          rows: [{ id: 'agent-session-uuid-1' }],
        });
      }

      return Promise.resolve({
        rows: [{ id: 'uuid-1', conversation_id: 'conversation-uuid' }],
      });
    }),
  };
}

const environment = 'prod';
const lastEventAt = new Date('2026-04-23T12:00:00Z');
let loggerWarn: ReturnType<typeof vi.fn>;
let loggerInfo: ReturnType<typeof vi.fn>;

describe('dispatcher', () => {
  beforeEach(() => {
    vi.resetModules();
    loggerInfo = vi.fn();
    loggerWarn = vi.fn();
    Object.assign(process.env, baseEnv);
    vi.doMock('pino', () => ({
      default: vi.fn(() => ({
        info: loggerInfo,
        warn: loggerWarn,
        error: vi.fn(),
      })),
    }));
  });

  afterEach(() => {
    vi.doUnmock('pino');
    vi.resetModules();
  });

  async function loadDispatcher() {
    const mod = await import('../../../src/normalization/dispatcher.js');
    return mod;
  }

  it('dispatches contact_created to contacts repository', async () => {
    const { dispatch } = await loadDispatcher();
    const client = createMockClient();
    const contactCreated = (await import('../../fixtures/chatwoot/contact_created.json')).default;

    await dispatch(client as unknown as import('pg').PoolClient, {
      id: 1,
      event_type: 'contact_created',
      payload: contactCreated,
      environment,
      chatwoot_timestamp: lastEventAt,
    });

    const calls = client.query.mock.calls;
    const upsertCall = calls.find((c) =>
      (c[0] as string).includes('INSERT INTO core.contacts'),
    );
    expect(upsertCall).toBeDefined();
  });

  it('dispatches conversation_created to conversations repository', async () => {
    const { dispatch } = await loadDispatcher();
    const client = createMockClient();
    const conversationCreated = (await import('../../fixtures/chatwoot/conversation_created.json')).default;

    await dispatch(client as unknown as import('pg').PoolClient, {
      id: 2,
      event_type: 'conversation_created',
      payload: conversationCreated,
      environment,
      chatwoot_timestamp: lastEventAt,
    });

    const calls = client.query.mock.calls;
    const upsertCall = calls.find((c) =>
      (c[0] as string).includes('INSERT INTO core.conversations'),
    );
    expect(upsertCall).toBeDefined();
  });

  it('upserts nested contact before conversation when sender is present in conversation meta', async () => {
    const { dispatch } = await loadDispatcher();
    const client = createMockClient();

    await dispatch(client as unknown as import('pg').PoolClient, {
      id: 21,
      event_type: 'conversation_created',
      payload: {
        id: 303,
        status: 'open',
        inbox_id: 1,
        meta: {
          sender: {
            id: 404,
            name: 'Contato Aninhado',
            email: 'contato@example.com',
            type: 'contact',
          },
        },
      },
      environment,
      chatwoot_timestamp: lastEventAt,
    });

    const calls = client.query.mock.calls;
    const contactIndex = calls.findIndex((c) =>
      (c[0] as string).includes('INSERT INTO core.contacts'),
    );
    const conversationIndex = calls.findIndex((c) =>
      (c[0] as string).includes('INSERT INTO core.conversations'),
    );

    expect(contactIndex).toBeGreaterThanOrEqual(0);
    expect(conversationIndex).toBeGreaterThan(contactIndex);
  });

  it('dispatches conversation_updated with tags', async () => {
    const { dispatch } = await loadDispatcher();
    const client = createMockClient();
    const conversationUpdated = (await import('../../fixtures/chatwoot/conversation_updated.json')).default;

    await dispatch(client as unknown as import('pg').PoolClient, {
      id: 3,
      event_type: 'conversation_updated',
      payload: conversationUpdated,
      environment,
      chatwoot_timestamp: lastEventAt,
    });

    const calls = client.query.mock.calls;
    const convUpsert = calls.find((c) =>
      (c[0] as string).includes('INSERT INTO core.conversations'),
    );
    const tagInsert = calls.find((c) =>
      (c[0] as string).includes('INSERT INTO core.conversation_tags'),
    );

    expect(convUpsert).toBeDefined();
    expect(tagInsert).toBeDefined();
  });

  it('dispatches conversation_updated with changed_attributes to status and assignment', async () => {
    const { dispatch } = await loadDispatcher();
    const client = createMockClient();

    await dispatch(client as unknown as import('pg').PoolClient, {
      id: 3,
      event_type: 'conversation_updated',
      payload: {
        id: 101,
        status: 'resolved',
        assignee_id: 42,
        team_id: 3,
        changed_attributes: [
          { attribute: 'status', previous_value: 'open', current_value: 'resolved' },
          { attribute: 'assignee_id', previous_value: null, current_value: 42 },
        ],
        labels: ['suporte'],
      },
      environment,
      chatwoot_timestamp: lastEventAt,
    });

    const calls = client.query.mock.calls;
    const statusInsert = calls.find((c) =>
      (c[0] as string).includes('INSERT INTO core.conversation_status_events'),
    );
    const assignmentInsert = calls.find((c) =>
      (c[0] as string).includes('INSERT INTO core.conversation_assignments'),
    );

    expect(statusInsert).toBeDefined();
    expect(assignmentInsert).toBeDefined();
  });

  it('dispatches conversation_status_changed with status event', async () => {
    const { dispatch } = await loadDispatcher();
    const client = createMockClient();
    const conversationStatusChanged = (await import('../../fixtures/chatwoot/conversation_status_changed.json')).default;

    await dispatch(client as unknown as import('pg').PoolClient, {
      id: 4,
      event_type: 'conversation_status_changed',
      payload: conversationStatusChanged,
      environment,
      chatwoot_timestamp: lastEventAt,
    });

    const calls = client.query.mock.calls;
    const statusInsert = calls.find((c) =>
      (c[0] as string).includes('INSERT INTO core.conversation_status_events'),
    );
    expect(statusInsert).toBeDefined();
  });

  it('dispatches message_created to messages repository', async () => {
    const { dispatch } = await loadDispatcher();
    const client = createMockClient();
    const messageCreated = (await import('../../fixtures/chatwoot/message_created.json')).default;

    await dispatch(client as unknown as import('pg').PoolClient, {
      id: 5,
      event_type: 'message_created',
      payload: messageCreated,
      environment,
      chatwoot_timestamp: lastEventAt,
    });

    const calls = client.query.mock.calls;
    const msgUpsert = calls.find((c) =>
      (c[0] as string).includes('INSERT INTO core.messages'),
    );
    expect(msgUpsert).toBeDefined();
  });

  it('enqueues organizadora job for message_created when enabled', async () => {
    process.env.ORGANIZADORA_ENABLED = 'true';
    process.env.ORGANIZADORA_DEBOUNCE_SECONDS = '10';
    const { dispatch } = await loadDispatcher();
    const client = createMockClient();
    const messageCreated = (await import('../../fixtures/chatwoot/message_created.json')).default;

    await dispatch(client as unknown as import('pg').PoolClient, {
      id: 55,
      event_type: 'message_created',
      payload: messageCreated,
      environment,
      chatwoot_timestamp: lastEventAt,
    });

    const enqueueCall = client.query.mock.calls.find((call) =>
      (call[0] as string).includes('ops.enqueue_enrichment_job'),
    );
    expect(enqueueCall).toBeDefined();
    expect(enqueueCall?.[1]).toEqual([
      environment,
      'conversation-uuid',
      'uuid-1',
      10,
    ]);
    expect(loggerInfo).toHaveBeenCalledWith(
      {
        raw_event_id: 55,
        conversation_id: 'conversation-uuid',
        message_id: 'uuid-1',
        enrichment_job_id: 'job-uuid-1',
      },
      'normalization: organizadora job enqueued',
    );
  });

  it('logs when organizadora enqueue is skipped by config', async () => {
    const { dispatch } = await loadDispatcher();
    const client = createMockClient();
    const messageCreated = (await import('../../fixtures/chatwoot/message_created.json')).default;

    await dispatch(client as unknown as import('pg').PoolClient, {
      id: 56,
      event_type: 'message_created',
      payload: messageCreated,
      environment,
      chatwoot_timestamp: lastEventAt,
    });

    const enqueueCall = client.query.mock.calls.find((call) =>
      (call[0] as string).includes('ops.enqueue_enrichment_job'),
    );
    expect(enqueueCall).toBeUndefined();
    expect(loggerWarn).toHaveBeenCalledWith(
      {
        raw_event_id: 56,
        conversation_id: 'conversation-uuid',
        message_id: 'uuid-1',
      },
      'normalization: organizadora job skipped because ORGANIZADORA_ENABLED=false',
    );
  });

  it('enqueues atendente job for message_created when shadow is enabled', async () => {
    process.env.ATENDENTE_SHADOW_ENABLED = 'true';
    const { dispatch } = await loadDispatcher();
    const client = createMockClient();
    const messageCreated = (await import('../../fixtures/chatwoot/message_created.json')).default;

    await dispatch(client as unknown as import('pg').PoolClient, {
      id: 57,
      event_type: 'message_created',
      payload: messageCreated,
      environment,
      chatwoot_timestamp: lastEventAt,
    });

    const sessionCall = client.query.mock.calls.find((call) =>
      (call[0] as string).includes('INSERT INTO agent.session_current'),
    );
    expect(sessionCall).toBeDefined();
    expect(sessionCall?.[1]).toEqual([
      environment,
      'conversation-uuid',
      'uuid-1',
    ]);

    const enqueueCall = client.query.mock.calls.find((call) =>
      (call[0] as string).includes('ops.enqueue_atendente_job'),
    );
    expect(enqueueCall).toBeDefined();
    expect(enqueueCall?.[1]).toEqual([
      environment,
      'conversation-uuid',
      'uuid-1',
    ]);
    expect(loggerInfo).toHaveBeenCalledWith(
      {
        raw_event_id: 57,
        conversation_id: 'conversation-uuid',
        message_id: 'uuid-1',
        agent_session_id: 'agent-session-uuid-1',
        atendente_job_id: 'atendente-job-uuid-1',
      },
      'normalization: atendente job enqueued',
    );
  });

  it('does not enqueue atendente job when shadow is disabled', async () => {
    const { dispatch } = await loadDispatcher();
    const client = createMockClient();
    const messageCreated = (await import('../../fixtures/chatwoot/message_created.json')).default;

    await dispatch(client as unknown as import('pg').PoolClient, {
      id: 58,
      event_type: 'message_created',
      payload: messageCreated,
      environment,
      chatwoot_timestamp: lastEventAt,
    });

    const enqueueCall = client.query.mock.calls.find((call) =>
      (call[0] as string).includes('ops.enqueue_atendente_job'),
    );
    const sessionCall = client.query.mock.calls.find((call) =>
      (call[0] as string).includes('INSERT INTO agent.session_current'),
    );
    expect(enqueueCall).toBeUndefined();
    expect(sessionCall).toBeUndefined();
    expect(loggerInfo).toHaveBeenCalledWith(
      {
        raw_event_id: 58,
        conversation_id: 'conversation-uuid',
        message_id: 'uuid-1',
      },
      'normalization: atendente job skipped because ATENDENTE_SHADOW_ENABLED=false',
    );
  });

  it('does not enqueue atendente job for message from human agent (sender_type=user)', async () => {
    process.env.ATENDENTE_SHADOW_ENABLED = 'true';
    const { dispatch } = await loadDispatcher();
    const client = createMockClient();

    await dispatch(client as unknown as import('pg').PoolClient, {
      id: 59,
      event_type: 'message_created',
      payload: {
        id: 600,
        message_type: 'outgoing',
        content: 'Olá, posso ajudar?',
        sender_type: 'User',
        conversation: { id: 303 },
      },
      environment,
      chatwoot_timestamp: lastEventAt,
    });

    const enqueueCall = client.query.mock.calls.find((call) =>
      (call[0] as string).includes('ops.enqueue_atendente_job'),
    );
    const sessionCall = client.query.mock.calls.find((call) =>
      (call[0] as string).includes('INSERT INTO agent.session_current'),
    );
    expect(enqueueCall).toBeUndefined();
    expect(sessionCall).toBeUndefined();
    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        raw_event_id: 59,
        sender_type: 'user',
      }),
      'normalization: atendente job skipped — sender_type is not contact',
    );
  });

  it('does not enqueue atendente job for message from bot (sender_type=agent_bot)', async () => {
    process.env.ATENDENTE_SHADOW_ENABLED = 'true';
    const { dispatch } = await loadDispatcher();
    const client = createMockClient();

    await dispatch(client as unknown as import('pg').PoolClient, {
      id: 60,
      event_type: 'message_created',
      payload: {
        id: 601,
        message_type: 'outgoing',
        content: 'Resposta automática do bot.',
        sender_type: 'agent_bot',
        conversation: { id: 303 },
      },
      environment,
      chatwoot_timestamp: lastEventAt,
    });

    const enqueueCall = client.query.mock.calls.find((call) =>
      (call[0] as string).includes('ops.enqueue_atendente_job'),
    );
    expect(enqueueCall).toBeUndefined();
    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        raw_event_id: 60,
        sender_type: 'agent_bot',
      }),
      'normalization: atendente job skipped — sender_type is not contact',
    );
  });


  it('upserts nested contact before message when sender is present', async () => {
    const { dispatch } = await loadDispatcher();
    const client = createMockClient();

    await dispatch(client as unknown as import('pg').PoolClient, {
      id: 22,
      event_type: 'message_created',
      payload: {
        id: 505,
        message_type: 'incoming',
        content: 'mensagem',
        conversation: { id: 303 },
        sender: {
          id: 404,
          name: 'Contato Mensagem',
          email: 'mensagem@example.com',
        },
      },
      environment,
      chatwoot_timestamp: lastEventAt,
    });

    const calls = client.query.mock.calls;
    const contactIndex = calls.findIndex((c) =>
      (c[0] as string).includes('INSERT INTO core.contacts'),
    );
    const messageIndex = calls.findIndex((c) =>
      (c[0] as string).includes('INSERT INTO core.messages'),
    );

    expect(contactIndex).toBeGreaterThanOrEqual(0);
    expect(messageIndex).toBeGreaterThan(contactIndex);
  });

  it('dispatches message_created with attachments', async () => {
    const { dispatch } = await loadDispatcher();
    const client = createMockClient();
    const messageWithAttachment = (await import('../../fixtures/chatwoot/message_with_attachment.json')).default;

    await dispatch(client as unknown as import('pg').PoolClient, {
      id: 6,
      event_type: 'message_created',
      payload: messageWithAttachment,
      environment,
      chatwoot_timestamp: lastEventAt,
    });

    const calls = client.query.mock.calls;
    const attUpsert = calls.find((c) =>
      (c[0] as string).includes('INSERT INTO core.message_attachments'),
    );
    expect(attUpsert).toBeDefined();
    expect(attUpsert?.[1]?.[3]).toBe('conversation-uuid');
  });

  it('warns when reaction payload is present but the mapper is still a placeholder', async () => {
    const { dispatch } = await loadDispatcher();
    const client = createMockClient();
    const messageCreated = (await import('../../fixtures/chatwoot/message_created.json')).default;

    await dispatch(client as unknown as import('pg').PoolClient, {
      id: 8,
      event_type: 'message_created',
      payload: {
        ...messageCreated,
        reactions: [{ emoji: ':thumbsup:', reactor_id: 42, reactor_type: 'agent' }],
      },
      environment,
      chatwoot_timestamp: lastEventAt,
    });

    expect(loggerWarn).toHaveBeenCalledWith(
      { raw_event_id: 8, event_type: 'message_created' },
      'reaction payload received but mapper is placeholder',
    );
  });

  it('throws SkipEventError for unknown event types', async () => {
    const { dispatch, SkipEventError } = await loadDispatcher();
    const client = createMockClient();

    await expect(
      dispatch(client as unknown as import('pg').PoolClient, {
        id: 7,
        event_type: 'unknown_event',
        payload: {},
        environment,
        chatwoot_timestamp: lastEventAt,
      }),
    ).rejects.toBeInstanceOf(SkipEventError);
  });

  it('throws SkipEventError when event_type is in SKIP_EVENT_TYPES', async () => {
    process.env.SKIP_EVENT_TYPES = 'message_updated';
    const { dispatch, SkipEventError } = await loadDispatcher();
    const client = createMockClient();

    await expect(
      dispatch(client as unknown as import('pg').PoolClient, {
        id: 9,
        event_type: 'message_updated',
        payload: { id: 1, conversation: { id: 1 }, content: 'x' },
        environment,
        chatwoot_timestamp: lastEventAt,
      }),
    ).rejects.toBeInstanceOf(SkipEventError);

    const calls = client.query.mock.calls;
    const upsertMessage = calls.find((c) =>
      (c[0] as string).includes('INSERT INTO core.messages'),
    );
    expect(upsertMessage).toBeUndefined();

    delete process.env.SKIP_EVENT_TYPES;
  });

  it('does not skip events that are not in SKIP_EVENT_TYPES', async () => {
    process.env.SKIP_EVENT_TYPES = 'message_updated';
    const { dispatch } = await loadDispatcher();
    const client = createMockClient();
    const messageCreated = (await import('../../fixtures/chatwoot/message_created.json')).default;

    await dispatch(client as unknown as import('pg').PoolClient, {
      id: 10,
      event_type: 'message_created',
      payload: messageCreated,
      environment,
      chatwoot_timestamp: lastEventAt,
    });

    const calls = client.query.mock.calls;
    const upsertMessage = calls.find((c) =>
      (c[0] as string).includes('INSERT INTO core.messages'),
    );
    expect(upsertMessage).toBeDefined();

    delete process.env.SKIP_EVENT_TYPES;
  });
});

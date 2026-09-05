import { describe, expect, it, vi } from 'vitest';
import { upsertConversation } from '../../../src/persistence/conversations.repository.js';
import type { MappedConversation } from '../../../src/normalization/conversation.mapper.js';

function createConversation(): MappedConversation {
  const now = new Date('2026-04-23T12:00:00Z');
  return {
    environment: 'prod',
    chatwootConversationId: 101,
    chatwootAccountId: 1,
    chatwootInboxId: 5,
    channelType: null,
    chatwootContactId: 201,
    currentStatus: 'open',
    currentAssigneeId: null,
    currentTeamId: null,
    priority: null,
    startedAt: now,
    lastActivityAt: now,
    resolvedAt: null,
    waitingSince: null,
    additionalAttributes: {},
    customAttributes: {},
    lastEventAt: now,
  };
}

describe('conversations.repository', () => {
  it('não sobrescreve uma conta válida com zero de payload incompleto', async () => {
    const client = { query:vi.fn().mockResolvedValue({ rows:[{ id:'conversation' }] }) };
    await upsertConversation(client as never,{ ...createConversation(),chatwootAccountId:0 });
    expect(client.query.mock.calls[0][0]).toContain('CASE WHEN EXCLUDED.chatwoot_account_id > 0');
    expect(client.query.mock.calls[0][0]).toContain('ELSE core.conversations.chatwoot_account_id END');
  });
  it('returns existing conversation id when stale upsert returns no rows', async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 'existing-conversation-uuid' }] }),
    };

    await expect(
      upsertConversation(client as never, createConversation()),
    ).resolves.toBe('existing-conversation-uuid');

    expect(client.query.mock.calls[1][0]).toContain('FROM core.conversations');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { loadLastAcceptedAgentText } from '../../../src/atendente-v2/turn-guards.js';

describe('agent_v2 turn guards', () => {
  it('ignores generated, failed and blocked turns in the anti-echo lookup', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };

    await expect(loadLastAcceptedAgentText(client as never, 'prod', 'conv-1'))
      .resolves.toBeNull();

    const sql = String(client.query.mock.calls[0]?.[0]);
    expect(sql).toContain("status IN ('sent_api_ack', 'delivered')");
    expect(sql).not.toContain("'generated'");
    expect(sql).not.toContain("'failed'");
    expect(sql).not.toContain("'blocked'");
  });
});

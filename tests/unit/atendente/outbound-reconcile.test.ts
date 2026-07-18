import { describe, expect, it, vi } from 'vitest';
import { reconcileAgentOutboundDelivery } from '../../../src/atendente-v2/outbound-reconcile.js';

describe('agent_v2 outbound reconciliation', () => {
  it('matches by the provider message id and stores core delivery proof', async () => {
    const client = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'out-1', turn_id: 'turn-1' }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) };

    await expect(reconcileAgentOutboundDelivery(
      client as never, 'prod', 'core-message-1', 987,
    )).resolves.toBe(true);

    const outboundSql = String(client.query.mock.calls[0]?.[0]);
    expect(outboundSql).toContain('provider_message_id=$2');
    expect(outboundSql).not.toContain('echo_id');
    const turnSql = String(client.query.mock.calls[1]?.[0]);
    expect(turnSql).toContain("status='delivered'");
    expect(turnSql).toContain('delivered_message_id=$3');
    expect(client.query.mock.calls[1]?.[1]).toEqual(['prod', 987, 'core-message-1', 'turn-1']);
  });
});

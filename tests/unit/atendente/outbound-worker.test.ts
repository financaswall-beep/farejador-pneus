import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { OutboundRow } from '../../../src/atendente-v2/outbound-worker.js';

const row: OutboundRow = {
  id: 'out-1', environment: 'prod', conversation_id: 'conv-1', turn_id: 'turn-1',
  chatwoot_conversation_id: 123, echo_id: 'turn:turn-1', kind: 'agent_text',
  body: 'oi', attempts: 1,
};

let worker: typeof import('../../../src/atendente-v2/outbound-worker.js');
let ChatwootApiError: typeof import('../../../src/admin/chatwoot-api.client.js').ChatwootApiError;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test', FAREJADOR_ENV: 'prod',
    DATABASE_URL: 'postgresql://postgres:password@example.test:6543/postgres',
    CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'test-admin-token',
  });
  ({ ChatwootApiError } = await import('../../../src/admin/chatwoot-api.client.js'));
  worker = await import('../../../src/atendente-v2/outbound-worker.js');
});

describe('agent_v2 outbound worker', () => {
  it('claims due rows with SKIP LOCKED and records the sending lock', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [row] }) };
    await expect(worker.pickOutboundMessage(client as never, 'prod', 'worker-1'))
      .resolves.toEqual(row);
    const sql = String(client.query.mock.calls[0]?.[0]);
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain("status='sending'");
    expect(sql).toContain('attempts=attempts+1');
  });

  it('never blindly retries a sending row after a crash', async () => {
    const client = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [row], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) };
    await expect(worker.reclaimAmbiguousOutbound(client as never, 'prod')).resolves.toBe(1);
    expect(String(client.query.mock.calls[0]?.[0])).toContain("status='dead_letter'");
    expect(String(client.query.mock.calls[1]?.[0])).toContain('atendente_dead_letters');
  });

  it('sends an unknown provider result to human DLQ instead of retrying', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };
    await worker.markOutboundFailure(client as never, row,
      new ChatwootApiError('network result unknown', null));
    expect(String(client.query.mock.calls[0]?.[0])).toContain("status='dead_letter'");
    expect(String(client.query.mock.calls[0]?.[0])).not.toContain("status='failed'");
    expect(String(client.query.mock.calls[1]?.[0])).toContain('atendente_dead_letters');
  });

  it('supersedes a queued agent draft when a newer customer message exists', async () => {
    const client = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'out-1', turn_id: 'turn-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) };

    await expect(worker.supersedeStaleAgentOutbound(client as never, 'prod')).resolves.toBe(1);
    const sql = String(client.query.mock.calls[0]?.[0]);
    expect(sql).toContain("o2.status IN ('pending','failed')");
    expect(sql).toContain("m.sender_type='contact'");
    expect(sql).toContain("status='superseded'");
    expect(String(client.query.mock.calls[1]?.[0])).toContain("status='blocked'");
  });
});

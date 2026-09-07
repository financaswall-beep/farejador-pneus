import { beforeAll, describe, expect, it, vi } from 'vitest';

let lifecycle: typeof import('../../../src/atendente-v2/auto-resolve.js');

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test', FAREJADOR_ENV: 'prod',
    DATABASE_URL: 'postgresql://postgres:password@example.test:6543/postgres',
    CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'test-admin-token',
  });
  lifecycle = await import('../../../src/atendente-v2/auto-resolve.js');
});

describe('ciclo de vida automático da conversa', () => {
  it('aceita somente desistências inequívocas', () => {
    for (const text of ['Não quero mais', 'desisti, obrigado', 'pode cancelar!', 'Já comprei em outro lugar']) {
      expect(lifecycle.isExplicitDesistance(text)).toBe(true);
    }
    for (const text of ['não sei', 'talvez depois', 'está caro', 'cancelar o quê?', 'obrigado']) {
      expect(lifecycle.isExplicitDesistance(text)).toBe(false);
    }
  });

  it('repete no pré-envio todos os bloqueios operacionais e o id da última mensagem', async () => {
    const client = { query: vi.fn().mockResolvedValue({
      rows: [{ allowed: false, has_completed_order: false }],
    }) };
    await lifecycle.assessResolutionGuard(client as never, 'prod', 'conv-1', 'msg-9', 'out-1');
    const sql = String(client.query.mock.calls[0]?.[0]);
    expect(sql).toContain('expected.id=$3');
    expect(sql).toContain('conversation_bot_control');
    expect(sql).toContain('atendente_jobs');
    expect(sql).toContain('outbound_messages');
    expect(sql).toContain('atendente_dead_letters');
    expect(sql).toContain('agent.escalations');
    expect(sql).toContain('agent.order_drafts');
    expect(sql).toContain('agent.pending_confirmations');
    expect(sql).toContain('photo_requests');
    expect(sql).toContain('satisfaction_surveys');
    expect(sql).toContain('has_order_pending');
  });

  it('valida payload fechado da ação de resolução', () => {
    expect(lifecycle.parseResolutionPayload(JSON.stringify({
      expected_last_message_id: 'msg-1', reason: 'inactivity',
    }))).toEqual({ expected_last_message_id: 'msg-1', reason: 'inactivity' });
    expect(lifecycle.parseResolutionPayload('{"reason":"qualquer"}')).toBeNull();
  });
});

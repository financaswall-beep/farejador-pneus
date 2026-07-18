import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const baseEnv = {
  NODE_ENV: 'test', FAREJADOR_ENV: 'prod',
  DATABASE_URL: 'postgresql://postgres:password@example.test:6543/postgres',
  CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'test-admin-token',
};

async function loadQueries(enabled: boolean) {
  vi.resetModules();
  Object.assign(process.env, baseEnv, { BOT_OUTBOX: String(enabled) });
  return import('../../../src/admin/painel/queries-bot-resilience.js');
}

describe('painel bot resilience', () => {
  afterEach(() => vi.resetModules());

  it('is dormant and does not touch new tables while the flag is off', async () => {
    const { getBotResilience } = await loadQueries(false);
    const dbPool = { query: vi.fn() };
    await expect(getBotResilience('prod', dbPool as never)).resolves.toEqual({
      enabled: false, pending: 0, api_ack_unconfirmed: 0, dead_letters: [],
    });
    expect(dbPool.query).not.toHaveBeenCalled();
  });

  it('keeps human reprocess and resolve actions owner-only', () => {
    const source = readFileSync(new URL(
      '../../../src/admin/painel/route-bot.ts', import.meta.url,
    ), 'utf8');
    expect(source).toContain("post('/admin/api/bot/resiliencia/reprocessar', { preHandler: requireAdminOwner }");
    expect(source).toContain("post('/admin/api/bot/resiliencia/resolver', { preHandler: requireAdminOwner }");
  });

  it('lists only sanitized DLQ metadata without message bodies', async () => {
    const { getBotResilience } = await loadQueries(true);
    const dbPool = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [{ pending: 2, api_ack_unconfirmed: 1, dead_letters: 0 }] })
      .mockResolvedValueOnce({ rows: [] }) };
    await getBotResilience('prod', dbPool as never);
    const sql = String(dbPool.query.mock.calls[1]?.[0]);
    expect(sql).not.toMatch(/\bbody\b/i);
    expect(sql).not.toContain('say_text');
    expect(sql).toContain('error_summary');
  });

  it('requires explicit duplicate-risk confirmation before connecting', async () => {
    const { reprocessBotDeadLetter } = await loadQueries(true);
    const dbPool = { connect: vi.fn() };
    await expect(reprocessBotDeadLetter({ id: 'letter-1', actor: 'owner',
      reason: 'revisto pelo dono', risk_confirmed: false }, dbPool as never))
      .rejects.toThrow('bot_reprocess_risk_confirmation_required');
    expect(dbPool.connect).not.toHaveBeenCalled();
  });

  it('does not resolve a letter when its target is no longer requeueable', async () => {
    const { reprocessBotDeadLetter } = await loadQueries(true);
    const client = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ job_id: null, outbound_id: 'out-1' }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [] }), release: vi.fn() };
    const dbPool = { connect: vi.fn().mockResolvedValue(client) };
    await expect(reprocessBotDeadLetter({ id: 'letter-1', actor: 'owner',
      reason: 'revisto pelo dono', risk_confirmed: true }, dbPool as never))
      .rejects.toThrow('bot_dead_letter_target_not_requeueable');
    expect(String(client.query.mock.calls.at(-1)?.[0])).toBe('ROLLBACK');
  });
});

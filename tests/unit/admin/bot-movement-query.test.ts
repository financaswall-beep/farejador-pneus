import type { Pool } from 'pg';
import { beforeAll, describe, expect, it, vi } from 'vitest';

let getBotMovement: typeof import('../../../src/admin/painel/queries-bot-movimento.js').getBotMovement;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test', FAREJADOR_ENV: 'test',
    DATABASE_URL: 'postgresql://postgres:password@example.test:6543/postgres',
    CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'test-admin-token',
  });
  ({ getBotMovement } = await import('../../../src/admin/painel/queries-bot-movimento.js'));
});

function fakePool() {
  const hours = Array.from({ length: 24 }, (_, hora) => ({ hora, conversas: hora === 10 ? 6 : 0 }));
  const query = vi.fn()
    .mockResolvedValueOnce({ rows: [
      { bucket: 'current', conversas: 10, fecharam: 2, faturamento: '135.00' },
      { bucket: 'previous', conversas: 5, fecharam: 1, faturamento: '50.00' },
    ] })
    .mockResolvedValueOnce({ rows: hours });
  return { pool: { query } as unknown as Pool, query };
}

describe('consulta do movimento do Bot', () => {
  it('calcula cards e comparação diária com matemática causal', async () => {
    const { pool, query } = fakePool();
    const payload = await getBotMovement({
      mode: 'daily', selectedDate: '2026-08-21', today: '2026-08-22',
    }, 'test', pool);

    expect(payload.range).toMatchObject({
      from: '2026-08-21', to: '2026-08-21',
      previous_from: '2026-08-20', previous_to: '2026-08-20',
    });
    expect(payload.cards).toEqual({
      conversas: 10, fecharam: 2, faturamento: 135,
      ticket_medio: 67.5,
    });
    expect(payload.comparison).toEqual({
      conversas_pct: 100, fecharam_delta: 1, faturamento_pct: 170,
    });
    expect(payload.horarios).toHaveLength(24);
    expect(query.mock.calls[0]?.[1]).toEqual([
      'test', '2026-08-21', '2026-08-21', '2026-08-20', '2026-08-20',
    ]);
    expect(String(query.mock.calls[0]?.[0])).toContain("an_order.source IN ('bot_promoted', 'chatwoot_com_bot')");
    expect(String(query.mock.calls[0]?.[0])).toContain('an_order.created_at >=');
  });

  it('usa domingo a sábado e compara os mesmos dias da semana anterior', async () => {
    const { pool, query } = fakePool();
    const payload = await getBotMovement({
      mode: 'weekly', selectedDate: '2026-08-18', today: '2026-08-18',
    }, 'test', pool);

    expect(payload.range).toMatchObject({
      from: '2026-08-16', to: '2026-08-18',
      previous_from: '2026-08-09', previous_to: '2026-08-11',
    });
    expect(query.mock.calls[1]?.[1]).toEqual(['test', '2026-08-16', '2026-08-18']);
  });
});

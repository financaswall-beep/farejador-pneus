import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

async function buildRoute() {
  vi.resetModules();
  vi.doMock('../../../src/admin/painel/route-bot-control.js', () => ({ registerBotControlRoutes:vi.fn() }));
  const getBotMovement = vi.fn().mockResolvedValue({ cards: {}, horarios: [] });
  vi.doMock('../../../src/admin/auth.js', () => ({
    requireAdminAuth: async () => undefined,
    requireAdminOwner: async () => undefined,
  }));
  vi.doMock('../../../src/shared/business-time.js', () => ({
    businessDateSaoPaulo: () => '2026-08-22',
  }));
  vi.doMock('../../../src/shared/logger.js', () => ({ logger: { error: vi.fn() } }));
  vi.doMock('../../../src/admin/painel/queries.js', () => ({
    getBotMovement,
    getBotCampainha: vi.fn(), getBotVisao: vi.fn(), getBotResilience: vi.fn(),
    reprocessBotDeadLetter: vi.fn(), resolveBotDeadLetter: vi.fn(),
  }));
  vi.doMock('../../../src/admin/painel/route-helpers.js', () => ({ operatorLabel: () => 'owner:test' }));
  const { registerPainelBot } = await import('../../../src/admin/painel/route-bot.js');
  const app = Fastify();
  await registerPainelBot(app);
  return { app, getBotMovement };
}

describe('rota do movimento do Bot', () => {
  it('recusa data impossível e data futura', async () => {
    const { app, getBotMovement } = await buildRoute();
    const impossible = await app.inject({ method: 'GET', url: '/admin/api/bot/movimento?mode=daily&date=2026-02-31' });
    const future = await app.inject({ method: 'GET', url: '/admin/api/bot/movimento?mode=weekly&date=2026-08-23' });

    expect(impossible.statusCode).toBe(400);
    expect(impossible.json()).toEqual({ error: 'invalid_query' });
    expect(future.statusCode).toBe(400);
    expect(future.json()).toEqual({ error: 'future_date_not_allowed' });
    expect(getBotMovement).not.toHaveBeenCalled();
    await app.close();
  });

  it('encaminha um único recorte validado para a consulta', async () => {
    const { app, getBotMovement } = await buildRoute();
    const response = await app.inject({ method: 'GET', url: '/admin/api/bot/movimento?mode=weekly&date=2026-08-21' });

    expect(response.statusCode).toBe(200);
    expect(getBotMovement).toHaveBeenCalledWith({
      mode: 'weekly', selectedDate: '2026-08-21', today: '2026-08-22',
    });
    await app.close();
  });
});

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

const recordEvent = vi.fn();
const resolvePermissions = vi.fn();
const context = {
  environment: 'test', partnerId: 'partner-a', partnerUnitId: 'unit-a', unitId: 'core-a',
  slug: 'loja-a', partnerName: 'Parceiro A', unitName: 'Loja A', role: 'owner', tokenId: 'token-a',
};

async function app() {
  vi.resetModules();
  vi.doMock('../../../src/parceiro/auth.js', () => ({
    requirePartnerAuth: async (request: Record<string, unknown>) => { request.partnerContext = context; },
    getPartnerContext: (request: { partnerContext: unknown }) => request.partnerContext,
    resolvePartnerPermissions: resolvePermissions,
  }));
  vi.doMock('../../../src/parceiro/panel-canary.js', () => ({
    recordPartnerPanelCanaryEvent: recordEvent,
  }));
  const fastify = Fastify();
  const { registerPartnerPanelCanaryRoutes } = await import('../../../src/parceiro/route-panel-canary.js');
  registerPartnerPanelCanaryRoutes(fastify);
  return fastify;
}

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('rota de telemetria do canário parceiro', () => {
  it('aceita somente evento técnico allowlisted da tela autorizada', async () => {
    resolvePermissions.mockResolvedValue({ resumo: true, retiradas: true });
    recordEvent.mockResolvedValue(true);
    const fastify = await app();
    const response = await fastify.inject({
      method: 'POST', url: '/parceiro/loja-a/api/panel-canary-events',
      payload: {
        page: 'retiradas', event_type: 'write', operation: 'confirm_pickup',
        outcome: 'success', status_code: 200, duration_ms: 18,
      },
    });
    await fastify.close();
    expect(response.statusCode).toBe(202);
    expect(recordEvent).toHaveBeenCalledWith(context, expect.objectContaining({
      page: 'retiradas', operation: 'confirm_pickup', durationMs: 18,
    }));
  });

  it('recusa payload com PII/campo livre e operação incompatível', async () => {
    resolvePermissions.mockResolvedValue({ resumo: true, retiradas: true });
    const fastify = await app();
    const pii = await fastify.inject({
      method: 'POST', url: '/parceiro/loja-a/api/panel-canary-events',
      payload: {
        page: 'resumo', event_type: 'read', operation: 'load_summary', outcome: 'success',
        customer_phone: '21999999999',
      },
    });
    const mismatch = await fastify.inject({
      method: 'POST', url: '/parceiro/loja-a/api/panel-canary-events',
      payload: {
        page: 'resumo', event_type: 'write', operation: 'confirm_pickup', outcome: 'success',
      },
    });
    await fastify.close();
    expect(pii.statusCode).toBe(400);
    expect(mismatch.statusCode).toBe(400);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('falha fechado sem permissão ou quando a Matriz desligou a unidade', async () => {
    resolvePermissions.mockResolvedValue({ resumo: false, retiradas: false });
    recordEvent.mockResolvedValue(false);
    let fastify = await app();
    const forbidden = await fastify.inject({
      method: 'POST', url: '/parceiro/loja-a/api/panel-canary-events',
      payload: { page: 'resumo', event_type: 'page_open', outcome: 'success' },
    });
    await fastify.close();
    expect(forbidden.statusCode).toBe(403);

    resolvePermissions.mockResolvedValue({ resumo: true, retiradas: false });
    fastify = await app();
    const disabled = await fastify.inject({
      method: 'POST', url: '/parceiro/loja-a/api/panel-canary-events',
      payload: { page: 'resumo', event_type: 'page_open', outcome: 'success' },
    });
    await fastify.close();
    expect(disabled.statusCode).toBe(409);
    expect(disabled.json()).toEqual({ error: 'modern_panel_disabled' });
  });
});

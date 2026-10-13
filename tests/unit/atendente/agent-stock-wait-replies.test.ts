import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, responseBody, textItem } from './responses-fixtures.js';
import type { StockRequest } from '../../../src/atendente-v2/stock-confirmation-store.js';
const WAIT = 'Estou confirmando esses pneus com a loja. Já te aviso assim que ela responder.';
const FOLLOWUP = 'A loja ainda não respondeu. Já te aviso assim que ela responder.';
const mocks = vi.hoisted(() => ({ may: vi.fn(), send: vi.fn(), tool: vi.fn(), history: vi.fn(),
  request: null as StockRequest | null, accepted: '', client: { query: vi.fn(), release: vi.fn() } }));
vi.mock('../../../src/persistence/db.js', () => ({ pool: { connect: async () => mocks.client } }));
vi.mock('../../../src/atendente-v2/conversation-control.js', () => ({ botMayProcessTrigger: mocks.may }));
vi.mock('../../../src/atendente-v2/history.js', () => ({ loadHistory: mocks.history, lookupChatwootConversationId: async () => 12 }));
vi.mock('../../../src/atendente-v2/tools.js', () => ({ activeToolDefinitions: () => [], executeTool: mocks.tool }));
vi.mock('../../../src/shared/clientes-kanban.notify.js', () => ({ notifyClientesKanban: vi.fn() }));
vi.mock('../../../src/atendente-v2/final-send.js', () => ({ sendFinalAgentText: mocks.send }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
function request(measure = '140/70-17', quantity = 1): StockRequest {
  return { id: measure, status: 'pending', sealed: true, basket_key: `${measure}:${quantity}`,
    items: [{ tire_size: measure, tire_condition: 'meia_vida', quantity, price: 55 }] } as StockRequest;
}
const job = { jobId: 'job', conversationId: 'conversation', triggerMessageId: 'trigger', environment: 'test' };
beforeEach(() => {
  Object.assign(process.env, { NODE_ENV: 'test', FAREJADOR_ENV: 'test',
    DATABASE_URL: 'postgresql://test:test@example.test/test', CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'test-token',
    OPENAI_API_KEY: 'fixture-only', OPENAI_MODEL: 'gpt-5.6-sol', ROUTING_GEO: 'false', SATISFACTION_SURVEY: 'false',
    PHOTO_REQUESTS: 'false', PARTNER_STOCK_CONFIRMATION: 'true', BOT_OUTBOX: 'true', ORGANIC_ATTRIBUTION_ENABLED: 'false' });
  vi.resetAllMocks(); mocks.request = request(); mocks.accepted = WAIT;
  mocks.may.mockResolvedValue(true); mocks.send.mockResolvedValue('sent');
  mocks.history.mockResolvedValue([{ role: 'user', content: 'Já teve alguma resposta da loja?' }]);
  mocks.client.query.mockImplementation(async (sql: string) => ({ rows:
    sql.includes('FROM commerce.partner_stock_requests') ? (mocks.request ? [mocks.request] : [])
    : sql.includes('SELECT say_text') ? [{ say_text: mocks.accepted }] : [] }));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(responseBody([textItem('Tenho sim! Pode comprar.')]))));
});
afterEach(() => { vi.unstubAllGlobals(); });
describe('resposta do agente durante confirmação de estoque', () => {
  it.each([WAIT, FOLLOWUP])('responde pergunta de andamento mesmo depois de: %s', async accepted => {
    mocks.accepted = accepted;
    const { runAgentV2 } = await import('../../../src/atendente-v2/agent.js'); await runAgentV2(job);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0]?.[1]).toMatchObject({ body: FOLLOWUP, triggerMessageId: 'trigger' });
    expect(mocks.tool).not.toHaveBeenCalled();
    expect(mocks.client.query.mock.calls.some(([sql]) => /INSERT INTO commerce\.partner_stock_requests|SET expires_at/.test(sql))).toBe(false);
  });
  it.each([['90/90-18', 1], ['140/70-17', 2]] as const)('avisa mudança para %s, quantidade %i, sem prometer disponibilidade', async (measure, quantity) => {
    const next = request(measure, quantity); next.id = 'new-request'; next.sealed = false;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      mocks.request = next; return jsonResponse(responseBody([textItem('Tenho sim! Já reservei por R$ 55.')]));
    }));
    const { runAgentV2 } = await import('../../../src/atendente-v2/agent.js'); await runAgentV2(job);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    const body = mocks.send.mock.calls[0]?.[1].body;
    expect(body).toContain(`Atualizei a consulta para ${quantity} ${quantity === 1 ? 'pneu' : 'pneus'} ${measure}`);
    expect(body).toContain('Estou confirmando com a loja.'); expect(body).not.toMatch(/Tenho|reservei|R\$/);
  });
  it('envia primeira espera mesmo se uma consulta anterior terminou com o mesmo texto', async () => {
    mocks.request = null;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      mocks.request = request(); mocks.request.sealed = false; return jsonResponse(responseBody([textItem('Tenho!')]));
    }));
    const { runAgentV2 } = await import('../../../src/atendente-v2/agent.js'); await runAgentV2(job);
    expect(mocks.send).toHaveBeenCalledTimes(1); expect(mocks.send.mock.calls[0]?.[1].body).toBe(WAIT);
  });
  it.each(['confirmed', 'cancelled', 'expired', 'matrix'])('preserva anti-eco fora de consulta pendente: %s', async status => {
    mocks.request!.status = status; mocks.accepted = 'Resposta repetida';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(responseBody([textItem('Resposta repetida')]))));
    const { runAgentV2 } = await import('../../../src/atendente-v2/agent.js'); await runAgentV2(job);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('não envia espera se o humano assumir durante a geração', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      mocks.may.mockResolvedValue(false); return jsonResponse(responseBody([textItem('Vou verificar.')]));
    }));
    const { runAgentV2 } = await import('../../../src/atendente-v2/agent.js'); await runAgentV2(job);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('com confirmação desligada preserva a resposta original e não lê consultas', async () => {
    const { env } = await import('../../../src/shared/config/env.js');
    env.PARTNER_STOCK_CONFIRMATION = false;
    try {
      mocks.accepted = 'Texto anterior';
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(responseBody([textItem('Resposta original')]))));
      const { runAgentV2 } = await import('../../../src/atendente-v2/agent.js'); await runAgentV2(job);
      expect(mocks.send.mock.calls[0]?.[1].body).toBe('Resposta original');
      expect(mocks.client.query.mock.calls.some(([sql]) => sql.includes('commerce.partner_stock_requests'))).toBe(false);
    } finally { env.PARTNER_STOCK_CONFIRMATION = true; }
  });
});

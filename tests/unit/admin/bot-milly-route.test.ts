import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  session: vi.fn(), ler: vi.fn(), definir: vi.fn(), canal: vi.fn(),
}));
vi.mock('../../../src/admin/session.js', () => ({
  ADMIN_SESSION_COOKIE: 'teste_session', validateMatrizAdminSession: mocks.session,
}));
vi.mock('../../../src/shared/config/env.js', () => ({
  env: { FAREJADOR_ENV: 'test', ADMIN_BEARER_FALLBACK_ENABLED: true, ADMIN_AUTH_TOKEN: 'emergencial-ficticio', AGENT_V2_WORKER_ENABLED: true, BOT_OUTBOX: true },
}));
vi.mock('../../../src/persistence/db.js', () => ({ pool: {} }));
vi.mock('../../../src/atendente-v2/milly-negociacao.js', () => ({
  lerConsultaMilly: mocks.ler, definirConsultaMilly: mocks.definir,
}));
vi.mock('../../../src/admin/dot/events/negotiation-live.js', () => ({
  canalConsultaMillyDisponivel: mocks.canal,
}));
import { registerBotMillyRoutes } from '../../../src/admin/painel/route-bot-milly.js';
import { env } from '../../../src/shared/config/env.js';

const url = '/admin/api/bot/consulta-milly';
const headers = { cookie: 'teste_session=teste', origin: 'http://localhost:80' };
const dono = { role: 'owner', authType: 'session', personId: 'dono-teste', modules: ['bot'] };
let app: ReturnType<typeof Fastify>;
beforeEach(() => {
  vi.resetAllMocks();
  env.AGENT_V2_WORKER_ENABLED = true;
  env.BOT_OUTBOX = true;
  mocks.session.mockResolvedValue(dono);
  app = Fastify();
  registerBotMillyRoutes(app);
});
afterEach(async () => { await app.close(); });

describe('controle de consultas comerciais à Milly', () => {
  it('separa canal disponível e preferência, e informa erro de leitura sem supor pausa', async () => {
    mocks.ler.mockResolvedValue(true);
    mocks.canal.mockResolvedValue(false);
    const result = await app.inject({ url, headers });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ ativa: true, canal_disponivel: false, fluxo_disponivel: true });
    expect(result.headers['cache-control']).toContain('no-store');
    mocks.canal.mockRejectedValue(new Error('canal indisponível'));
    expect((await app.inject({ url, headers })).json()).toEqual({ ativa: true, canal_disponivel: null, fluxo_disponivel: true });
    mocks.ler.mockRejectedValue(new Error('leitura indisponível'));
    expect((await app.inject({ url, headers })).statusCode).toBe(503);
  });

  it('salva a escolha para o dono autenticado e permite pausar independentemente do Dot', async () => {
    mocks.definir.mockImplementation((_db, _environment, ativa) => Promise.resolve(ativa));
    mocks.canal.mockRejectedValue(new Error('offline'));
    for (const ativa of [true, false, false]) {
      const result = await app.inject({ method: 'PUT', url, headers, payload: { ativa } });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual({ ativa, fluxo_disponivel: true });
      expect(mocks.definir).toHaveBeenLastCalledWith({}, 'test', ativa, dono.personId);
    }
    expect(mocks.canal).not.toHaveBeenCalled();
  });

  it.each(['AGENT_V2_WORKER_ENABLED', 'BOT_OUTBOX'] as const)('informa o fluxo indisponível e permite pausar com %s desligado', async flag => {
    env[flag] = false;
    mocks.ler.mockResolvedValue(true);
    mocks.canal.mockResolvedValue(true);
    mocks.definir.mockResolvedValue(false);
    expect((await app.inject({ url, headers })).json()).toEqual({ ativa: true, canal_disponivel: true, fluxo_disponivel: false });
    const pausa = await app.inject({ method: 'PUT', url, headers, payload: { ativa: false } });
    expect(pausa.json()).toEqual({ ativa: false, fluxo_disponivel: false });
  });

  it('aceita escrita só do proprietário logado e da mesma origem', async () => {
    const write = { method: 'PUT' as const, url, payload: { ativa: true } };
    expect((await app.inject(write)).statusCode).toBe(401);
    expect((await app.inject({ ...write, headers: { authorization: 'Bearer emergencial-ficticio' } })).statusCode).toBe(403);
    expect((await app.inject({ ...write, headers: { ...headers, origin: 'https://outro.exemplo' } })).json()).toEqual({ error: 'csrf_rejected' });
    mocks.session.mockResolvedValue({ ...dono, role: 'admin' });
    expect((await app.inject({ ...write, headers })).statusCode).toBe(403);
    expect((await app.inject({ url, headers })).statusCode).toBe(403);
    expect(mocks.definir).not.toHaveBeenCalled();
  });

  it('rejeita ambiente, ator ou estado inválido antes de persistir', async () => {
    for (const payload of [{ ativa: 'false' }, { ativa: true, environment: 'prod' }, { ativa: true, personId: 'outro' }]) {
      expect((await app.inject({ method: 'PUT', url, headers, payload })).statusCode).toBe(400);
    }
    expect(mocks.definir).not.toHaveBeenCalled();
  });
});

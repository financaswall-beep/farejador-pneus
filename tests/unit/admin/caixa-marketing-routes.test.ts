import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ query: vi.fn(), reserve: vi.fn(), complete: vi.fn(), draft: vi.fn(), submit: vi.fn(),
  reschedule: vi.fn(), action: vi.fn(), list: vi.fn(), resolve: vi.fn(), metrics: vi.fn(), caption: vi.fn(), sending: true }));
vi.mock('../../../src/shared/config/env.js', () => ({ env: { FAREJADOR_ENV: 'test', ORGANIC_ATTRIBUTION_ENABLED: false } }));
vi.mock('../../../src/persistence/db.js', () => ({ pool: { query: m.query } }));
vi.mock('../../../src/marketing/publisher/config.js', () => ({ publisherConfig: () => ({ enabled: true, sending: m.sending, storage_ready: false }),
  requirePublisher: () => {}, requireSending: () => { if (!m.sending) throw Error('disabled'); } }));
vi.mock('../../../src/marketing/publisher/media.js', () => ({ reserveMedia: m.reserve, finalizeMedia: m.complete, listMedia: vi.fn() }));
vi.mock('../../../src/marketing/publisher/posts.js', () => ({ listPosts: vi.fn(async () => []), saveDraft: m.draft, submitPost: m.submit, postAction: m.action }));
vi.mock('../../../src/marketing/publisher/reschedule.js', () => ({ reschedulePost: m.reschedule }));
vi.mock('../../../src/marketing/publisher/caption.js', () => ({ generateCaption: m.caption }));
vi.mock('../../../src/marketing/organic/results.js', () => ({ organicResults: m.list, resolveOrganicResult: m.resolve, organicResultMetrics: m.metrics }));
vi.mock('../../../src/social-comments/config.js', () => ({ commentsConfig: () => ({ token: 'never-return-this-token', pageId: '100', instagramId: '200' }) }));
import { registerCaixaMarketingRoutes } from '../../../src/admin/caixa/route-marketing.js';
const base = '/api/caixa/marketing', id = '00000000-0000-4000-8000-000000000001';
async function appFor(role: string | null = 'owner', flag = true, token = 'matrix-session') {
  const app = Fastify();
  const feature = async (_: FastifyRequest, reply: FastifyReply) => { if (!flag) await reply.code(404).send({ error: 'not_found' }); };
  const auth = async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.headers.authorization !== 'Bearer ' + token || token !== 'matrix-session') { await reply.code(401).send({ error: 'unauthorized' }); return; }
    Object.assign(request, { caixa: { panelRole: role, displayName: 'Proprietário da Matriz', personId: 'owner-person-id' } });
  };
  await registerCaixaMarketingRoutes(app, feature, auth); return app;
}
const headers = { authorization: 'Bearer matrix-session' };
beforeEach(() => { vi.clearAllMocks(); m.sending = true; m.query.mockResolvedValue({ rows: [{ ready: true }] });
  m.list.mockResolvedValue({ rows: [], active_platforms: [] }); m.draft.mockResolvedValue({ id, version: 1 });
  m.reschedule.mockResolvedValue({ id, version: 3 }); m.submit.mockResolvedValue({ id, status: 'scheduled' }); });
describe('Marketing do app usa a sessão da Matriz e os mesmos serviços do web', () => {
  const routes = [
    ['GET', '/publisher'], ['POST', '/publisher/media'], ['POST', '/publisher/media/' + id + '/complete'],
    ['PUT', '/publisher/posts/' + id], ['POST', '/publisher/posts/' + id + '/submit'],
    ['POST', '/publisher/posts/' + id + '/reschedule'], ['POST', '/publisher/posts/' + id + '/action'],
    ['POST', '/publisher/posts/' + id + '/reconcile'], ['POST', '/publisher/caption'], ['POST', '/publisher/connections'],
    ['GET', '/organic/results'], ['GET', '/organic/results/publisher:' + id], ['GET', '/organic/results/publisher:' + id + '/metrics'],
  ] as const;
  it.each([['admin', true, 'matrix-session', 403], [null, true, 'matrix-session', 403],
    ['owner', false, 'matrix-session', 404], ['owner', true, 'partner-session', 401]] as const)(
    'bloqueia papel=%s flag=%s token=%s antes de qualquer serviço', async (role, flag, token, expected) => {
      const app = await appFor(role, flag, token);
      try {
        for (const [method, path] of routes) expect((await app.inject({ method, url: base + path, headers: { authorization: 'Bearer ' + token }, ...(method === 'GET' ? {} : { payload: {} }) })).statusCode).toBe(expected);
        for (const mock of [m.query, m.reserve, m.complete, m.draft, m.submit, m.reschedule, m.action, m.list, m.resolve, m.metrics, m.caption]) expect(mock).not.toHaveBeenCalled();
      } finally { await app.close(); }
    });
  it('não aceita sessão ausente ou apenas cookie de outro painel', async () => {
    const app = await appFor();
    try { for (const h of [{}, { cookie: 'admin=owner' }]) expect((await app.inject({ url: base + '/publisher', headers: h })).statusCode).toBe(401); expect(m.query).not.toHaveBeenCalled(); }
    finally { await app.close(); }
  });
  it('salva o rascunho com ator da sessão e ambiente do servidor, sem permitir impersonação no corpo', async () => {
    const app = await appFor(), payload = { version: 0, title: 'Vídeo da loja', media_id: id, caption: 'Veja as opções.', destinations: [{ platform: 'instagram', format: 'reel' }], delete_after_publish: false };
    try {
      expect((await app.inject({ method: 'PUT', url: base + '/publisher/posts/' + id, headers, payload })).statusCode).toBe(200);
      expect(m.draft).toHaveBeenCalledWith(expect.anything(), 'test', id, payload, 'Proprietário da Matriz');
      for (const extra of [{ environment: 'prod' }, { created_by: 'Outra pessoa' }, { account_id: '999' }]) expect((await app.inject({ method: 'PUT', url: base + '/publisher/posts/' + id, headers, payload: { ...payload, ...extra } })).statusCode).toBe(400);
      expect(m.draft).toHaveBeenCalledOnce();
    } finally { await app.close(); }
  });
  it('repassa submissão e alteração de horário com versão, fuso e confirmação nos mesmos serviços', async () => {
    const app = await appFor(), payload = { version: 2, scheduled_at: '2026-10-28T18:00:00-03:00' };
    try {
      for (const suffix of ['submit', 'reschedule']) expect((await app.inject({ method: 'POST', url: base + '/publisher/posts/' + id + '/' + suffix, headers, payload })).statusCode).toBe(200);
      expect(m.submit).toHaveBeenCalledWith(expect.anything(), 'test', id, 2, payload.scheduled_at, 'Proprietário da Matriz');
      expect(m.reschedule).toHaveBeenCalledWith(expect.anything(), 'test', id, 2, payload.scheduled_at, 'Proprietário da Matriz');
      for (const invalid of [{ ...payload, scheduled_at: '2026-10-28T18:00:00' }, { ...payload, version: 0 }, { ...payload, environment: 'prod' }]) expect((await app.inject({ method: 'POST', url: base + '/publisher/posts/' + id + '/reschedule', headers, payload: invalid })).statusCode).toBe(400);
      expect(m.reschedule).toHaveBeenCalledOnce();
    } finally { await app.close(); }
  });
  it('mantém o bloqueio de envio quando desabilitado e nunca devolve erro externo ou token', async () => {
    const app = await appFor();
    try {
      m.sending = false;
      expect((await app.inject({ method: 'POST', url: base + '/publisher/posts/' + id + '/submit', headers, payload: { version: 1, scheduled_at: null } })).statusCode).toBe(503); expect(m.submit).not.toHaveBeenCalled();
      m.reserve.mockRejectedValue(Error('never-return-this-token'));
      const response = await app.inject({ method: 'POST', url: base + '/publisher/media', headers, payload: { id, name: 'foto.jpg', mime: 'image/jpeg', bytes: 20 } });
      expect(response.statusCode).toBe(503); expect(response.body).not.toContain('never-return-this-token');
    } finally { await app.close(); }
  });
  it('consulta resultados com escopo validado, cache privado e sem aceitar conta/ambiente arbitrário', async () => {
    const app = await appFor();
    try {
      const response = await app.inject({ url: base + '/organic/results?period=7d', headers });
      expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store'); expect(m.list.mock.calls[0]?.[1]).toBe('test');
      for (const suffix of ['?account_id=999', '?environment=prod', '/youtube:301', '/publisher:' + id + '?network=youtube']) expect((await app.inject({ url: base + '/organic/results' + suffix, headers })).statusCode).toBe(400);
    } finally { await app.close(); }
  });
});

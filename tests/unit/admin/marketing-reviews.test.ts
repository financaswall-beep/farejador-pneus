import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ metaList: vi.fn(), metaDecide: vi.fn(), googleList: vi.fn(), googleReview: vi.fn() }));
vi.mock('../../../src/marketing/meta-identity-decisions.js', () => ({ listMetaIdentityReviews: mocks.metaList, setMetaIdentityDecision: mocks.metaDecide }));
vi.mock('../../../src/marketing/google-conversion-review.js', () => ({ listGoogleConversionReviews: mocks.googleList, reviewGoogleConversion: mocks.googleReview }));
vi.mock('../../../src/admin/auth.js', () => ({ getAdminContext: () => ({ displayName: 'Administrador' }),
  requireAdminOwner: async (request: any, reply: any) => {
    if (request.headers['x-owner'] !== 'yes') return reply.code(403).send({ error: 'forbidden' });
  } }));
import { registerMarketingReviews } from '../../../src/admin/painel/route-marketing-reviews.js';

describe('revisões internas de Marketing', () => {
  beforeEach(() => vi.resetAllMocks());
  it('restringe leitura ao proprietário e recusa conta/ambiente fornecidos pelo navegador', async () => {
    const app = Fastify(); await registerMarketingReviews(app);
    try {
      for (const url of ['/admin/api/marketing/meta/identity-reviews', '/admin/api/marketing/google-ads/conversion-reviews']) {
        expect((await app.inject(url)).statusCode).toBe(403);
        for (const query of ['environment=prod', 'account=999', 'action_id=123']) {
          expect((await app.inject({ url: url + '?' + query, headers: { 'x-owner': 'yes' } })).statusCode).toBe(400);
        }
      }
      expect(mocks.metaList).not.toHaveBeenCalled(); expect(mocks.googleList).not.toHaveBeenCalled();
      mocks.googleList.mockResolvedValue({ rows: [] });
      const result = await app.inject({ url: '/admin/api/marketing/google-ads/conversion-reviews', headers: { 'x-owner': 'yes' } });
      expect(result.statusCode).toBe(200); expect(result.headers['cache-control']).toBe('no-store');
    } finally { await app.close(); }
  });
  it('deriva o ator da sessão, exige motivo e não expõe detalhes de falhas', async () => {
    const app = Fastify(); await registerMarketingReviews(app);
    const url = '/admin/api/marketing/meta/ad-accounts/act_123/ads/111/identity-decision';
    const send = (payload: object) => app.inject({ method: 'POST', url, payload, headers: { 'x-owner': 'yes' } });
    try {
      expect((await app.inject({ method: 'POST', url, payload: { scope: 'matrix', reason: 'Campanha própria' } })).statusCode).toBe(403);
      for (const payload of [{ scope: 'matrix', reason: 'curto' }, { scope: 'matrix', reason: 'Campanha própria', actor: 'Falso' },
        { scope: 'matrix', reason: 'Campanha própria', environment: 'prod' }]) expect((await send(payload)).statusCode).toBe(400);
      expect(mocks.metaDecide).not.toHaveBeenCalled();
      mocks.metaDecide.mockResolvedValue({ scope: 'matrix' });
      expect((await send({ scope: 'matrix', reason: '  Campanha própria  ' })).statusCode).toBe(200);
      expect(mocks.metaDecide).toHaveBeenCalledWith(expect.objectContaining({ account: 'act_123', ad: '111', scope: 'matrix', reason: 'Campanha própria', actor: 'Administrador' }));
      mocks.metaDecide.mockRejectedValue(new Error('private token or database detail'));
      const failure = await send({ scope: 'matrix', reason: 'Campanha própria' });
      expect(failure.statusCode).toBe(503); expect(failure.body).not.toContain('private');
    } finally { await app.close(); }
  });
  it('não permite reenviar conversão ambígua nem trocar o destino via formulário', async () => {
    const app = Fastify(); await registerMarketingReviews(app);
    const url = '/admin/api/marketing/google-ads/conversions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/review';
    const send = (payload: object) => app.inject({ method: 'POST', url, payload, headers: { 'x-owner': 'yes' } });
    try {
      expect((await send({ action: 'retry', reason: 'Conferi o envio', account: '999' })).statusCode).toBe(400);
      expect((await send({ action: 'send', reason: 'Conferi o envio' })).statusCode).toBe(400);
      mocks.googleReview.mockRejectedValue(new Error('google_retry_not_proven_safe'));
      const result = await send({ action: 'retry', reason: 'Conferi o envio' });
      expect(result.statusCode).toBe(409); expect(result.json().error).toBe('google_retry_not_proven_safe');
    } finally { await app.close(); }
  });
});

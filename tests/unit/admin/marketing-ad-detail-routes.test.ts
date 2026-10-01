import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ detail: vi.fn() }));
vi.mock('../../../src/admin/auth.js', () => ({ requireAdminOwner: async (req: any, reply: any) => {
  if (req.headers['x-owner'] !== 'yes') return reply.code(403).send({ error: 'forbidden' });
} }));
vi.mock('../../../src/shared/config/env.js', () => ({ env: { FAREJADOR_ENV: 'test' } }));
vi.mock('../../../src/persistence/db.js', () => ({ pool: {} }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { error: vi.fn() } }));
vi.mock('../../../src/admin/painel/queries-marketing-ad-detail.js', () => ({ getMarketingAdDetail: mocks.detail }));
vi.mock('../../../src/admin/painel/queries-marketing-creatives.js', () => ({ getMarketingCreatives: vi.fn(), marketingCreativeConfig: vi.fn() }));
vi.mock('../../../src/admin/painel/queries-marketing-creatives-data.js', () => ({ loadCreativeJourneys: vi.fn() }));
vi.mock('../../../src/marketing/meta-creatives.js', () => ({ getMetaCreativePreview: vi.fn() }));
import { registerMarketingCreatives } from '../../../src/admin/painel/route-marketing-creatives.js';

describe('Detalhe do anúncio — acesso e parâmetros', () => {
  beforeEach(() => vi.resetAllMocks());
  it('exige owner antes da consulta e rejeita conta, ambiente, período ou ID arbitrários', async () => {
    const app = Fastify(); await registerMarketingCreatives(app);
    try {
      expect((await app.inject('/admin/api/marketing/creatives/1/detail')).statusCode).toBe(403);
      for (const suffix of ['1/detail?account=other','1/detail?environment=prod','1/detail?period=all','abc/detail']) {
        expect((await app.inject({ url: '/admin/api/marketing/creatives/' + suffix, headers: { 'x-owner': 'yes' } })).statusCode).toBe(400);
      }
      expect(mocks.detail).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('retorna o detalhe sem cache e distingue ausência de indisponibilidade', async () => {
    const app = Fastify(); await registerMarketingCreatives(app);
    const options = { url: '/admin/api/marketing/creatives/123/detail?period=7d', headers: { 'x-owner': 'yes' } };
    try {
      mocks.detail.mockResolvedValueOnce({ available: true, ad: { id: '123' } }).mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ available: false }).mockRejectedValueOnce(Error('private failure'));
      const ok = await app.inject(options);
      expect(ok.statusCode).toBe(200); expect(ok.headers['cache-control']).toBe('no-store');
      expect(mocks.detail).toHaveBeenCalledWith('123','7d');
      expect((await app.inject(options)).statusCode).toBe(404);
      expect((await app.inject(options)).statusCode).toBe(503);
      const failure = await app.inject(options);
      expect(failure.statusCode).toBe(503); expect(failure.body).not.toContain('private failure');
    } finally { await app.close(); }
  });
});

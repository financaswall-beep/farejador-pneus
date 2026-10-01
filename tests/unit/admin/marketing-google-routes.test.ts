import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ report: vi.fn() }));
vi.mock('../../../src/shared/config/env.js',()=>({env:{GOOGLE_ADS_ENABLED:true}}));
vi.mock('../../../src/marketing/google-sync.js',()=>({syncGoogleAds:vi.fn()}));
vi.mock('../../../src/marketing/google-results.js',()=>({getGoogleResults:vi.fn().mockResolvedValue({available:true})}));
vi.mock('../../../src/admin/auth.js', () => ({ requireAdminOwner: async (req: any, reply: any) => {
  if (req.headers['x-owner'] !== 'yes') return reply.code(403).send({ error: 'forbidden' });
} }));
vi.mock('../../../src/marketing/google-ads-report.js', () => ({ getGoogleAdsReport: mocks.report,clearGoogleAdsReportCache:vi.fn() }));
import { registerMarketingGoogle } from '../../../src/admin/painel/route-marketing-google.js';

describe('Google Ads — rota de leitura', () => {
  it('exige proprietário e não aceita trocar conta, ambiente ou consulta pelo navegador', async () => {
    const app = Fastify(); await registerMarketingGoogle(app);
    try {
      expect((await app.inject('/admin/api/marketing/google-ads')).statusCode).toBe(403);
      for (const query of ['customerId=9999999999', 'environment=prod', 'query=anything', 'period=all']) {
        expect((await app.inject({ url: '/admin/api/marketing/google-ads?' + query, headers: { 'x-owner': 'yes' } })).statusCode).toBe(400);
      }
      expect(mocks.report).not.toHaveBeenCalled();
      mocks.report.mockResolvedValue({ status: 'connected', data: { campaigns: [] } });
      const response = await app.inject({ url: '/admin/api/marketing/google-ads?period=7d', headers: { 'x-owner': 'yes' } });
      expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
      expect(mocks.report).toHaveBeenCalledWith('7d');
    } finally { await app.close(); }
  });
});

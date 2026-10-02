import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ report: vi.fn(),activity:vi.fn() }));
vi.mock('../../../src/shared/config/env.js',()=>({env:{GOOGLE_ADS_ENABLED:true}}));
vi.mock('../../../src/marketing/google-sync.js',()=>({syncGoogleAds:vi.fn()}));
vi.mock('../../../src/marketing/google-results.js',()=>({getGoogleResults:vi.fn().mockResolvedValue({available:true})}));
vi.mock('../../../src/marketing/google-campaign-activity.js',()=>({getGoogleCampaignActivity:mocks.activity}));
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
  it('consulta só campanhas do relatório autorizado e não aceita conta, ambiente ou página inválida',async()=>{
    mocks.report.mockReset();mocks.activity.mockReset();
    const app=Fastify();await registerMarketingGoogle(app);
    try {
      expect((await app.inject('/admin/api/marketing/google-ads/campaign?campaign_id=11')).statusCode).toBe(403);
      for(const extra of ['account=999','environment=prod','order_page=0','conversation_page=1.5','period=all']) {
        expect((await app.inject({url:'/admin/api/marketing/google-ads/campaign?campaign_id=11&'+extra,headers:{'x-owner':'yes'}})).statusCode).toBe(400);
      }
      mocks.report.mockResolvedValue({data:{account:{id:'1234567890'},period:{since:'2026-09-25',until:'2026-10-01'},campaigns:[{id:'11'}]}});
      expect((await app.inject({url:'/admin/api/marketing/google-ads/campaign?campaign_id=99',headers:{'x-owner':'yes'}})).statusCode).toBe(404);
      expect(mocks.activity).not.toHaveBeenCalled();
      mocks.activity.mockResolvedValue({available:true,orders:{total:0,rows:[]}});
      const response=await app.inject({url:'/admin/api/marketing/google-ads/campaign?campaign_id=11&order_page=2',headers:{'x-owner':'yes'}});
      expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toBe('no-store');
      expect(mocks.activity).toHaveBeenCalledWith('1234567890','11','2026-09-25','2026-10-01',2,1);
      mocks.activity.mockRejectedValue(new Error('private database detail'));
      const failed=await app.inject({url:'/admin/api/marketing/google-ads/campaign?campaign_id=11',headers:{'x-owner':'yes'}});
      expect(failed.statusCode).toBe(503);expect(failed.body).not.toContain('private');
      mocks.report.mockResolvedValue({data:null});
      expect((await app.inject({url:'/admin/api/marketing/google-ads/campaign?campaign_id=11',headers:{'x-owner':'yes'}})).statusCode).toBe(503);
    } finally {await app.close();}
  });
});

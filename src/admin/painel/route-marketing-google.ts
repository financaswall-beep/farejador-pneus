import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminOwner } from '../auth.js';
import { getGoogleAdsReport, clearGoogleAdsReportCache } from '../../marketing/google-ads-report.js';
import { getGoogleResults } from '../../marketing/google-results.js';
import { syncGoogleAds } from '../../marketing/google-sync.js';
import { env } from '../../shared/config/env.js';

export async function registerMarketingGoogle(fastify: FastifyInstance): Promise<void> {
  fastify.get('/admin/api/marketing/google-ads', { preHandler: requireAdminOwner }, async (request, reply) => {
    const parsed = z.object({ period: z.enum(['7d', '30d']).default('30d') }).strict().safeParse(request.query ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_query' });
    const report = await getGoogleAdsReport(parsed.data.period);
    let results: Awaited<ReturnType<typeof getGoogleResults>> | {available:false} = {available:false};
    if (report.data) {
      try { results = await getGoogleResults(report.data.account.id,report.data.period.since,report.data.period.until); }
      catch { /* API e livro financeiro tem saude separada; nunca substituir falha do livro por lucro zero. */ }
    }
    return reply.header('Cache-Control', 'no-store').send({...report,results});
  });
  fastify.post('/admin/api/marketing/google-ads/sync',{preHandler:requireAdminOwner},async(request,reply)=>{
    if (!env.GOOGLE_ADS_ENABLED) return reply.code(409).send({error:'google_disabled'});
    if (!z.object({}).strict().safeParse(request.body??{}).success) return reply.code(400).send({error:'invalid_body'});
    try {
      const result=await syncGoogleAds();clearGoogleAdsReportCache();
      return reply.header('Cache-Control','no-store').send(result);
    }
    catch {return reply.code(503).send({error:'google_sync_unavailable'});}
  });
}

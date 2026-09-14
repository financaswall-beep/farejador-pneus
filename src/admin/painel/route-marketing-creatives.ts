import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminOwner } from '../auth.js';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';
import { getMarketingCreatives, marketingCreativeConfig } from './queries-marketing-creatives.js';
import { loadCreativeJourneys } from './queries-marketing-creatives-data.js';
import { marketingDateWindow } from './marketing-meta.js';
import { getMetaCreativePreview } from '../../marketing/meta-creatives.js';

const querySchema = z.object({ period: z.enum(['7d', '30d']).default('30d') }).strict();
const paramsSchema = z.object({ adId: z.string().regex(/^\d{1,40}$/) }).strict();
async function findAd(adId: string) {
  return (await pool.query<{ scope: string; name: string }>(
    `SELECT COALESCE(s.scope,'pending') AS scope,mi.entity_name AS name
       FROM marketing.meta_insights_daily mi
       LEFT JOIN marketing.campaign_scopes s ON s.environment=mi.environment
        AND s.ad_account_id=mi.ad_account_id AND s.campaign_id=mi.campaign_id
      WHERE mi.environment=$1 AND mi.ad_account_id=$2 AND mi.entity_level='ad' AND mi.entity_id=$3
      ORDER BY mi.metric_date DESC LIMIT 1`, [env.FAREJADOR_ENV, env.META_ADS_ACCOUNT_ID, adId],
  )).rows[0];
}
export async function registerMarketingCreatives(fastify: FastifyInstance): Promise<void> {
  fastify.get('/admin/api/marketing/creatives', { preHandler: requireAdminOwner }, async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    try { return reply.header('Cache-Control', 'no-store').send(await getMarketingCreatives(parsed.data.period)); }
    catch (err) {
      logger.error({ err }, 'marketing creatives read failed');
      return reply.code(503).send({ error: 'marketing_creatives_unavailable' });
    }
  });
  fastify.get('/admin/api/marketing/creatives/:adId/journeys', { preHandler: requireAdminOwner }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const query = querySchema.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: 'invalid_query' });
    try {
      const ad = await findAd(params.data.adId);
      if (!ad) return reply.code(404).send({ error: 'creative_not_found' });
      const window = marketingDateWindow(query.data.period);
      const commercial = env.MARKETING_ATTRIBUTION && (!env.MARKETING_SCOPE_ENFORCEMENT_ENABLED || ad.scope === 'matrix');
      const rows = await loadCreativeJourneys(pool, env.FAREJADOR_ENV, params.data.adId, window.since, window.until, commercial);
      return reply.header('Cache-Control', 'no-store').send({ name: ad.name, period: window,
        rows: rows.map((row) => ({ ...row, sales: commercial ? row.sales : null, revenue: commercial ? row.revenue : null })) });
    } catch (err) {
      logger.error({ err }, 'marketing creative journeys read failed');
      return reply.code(503).send({ error: 'marketing_creative_journeys_unavailable' });
    }
  });
  fastify.get('/admin/api/marketing/creatives/:adId/preview', { preHandler: requireAdminOwner }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_query' });
    const config = marketingCreativeConfig();
    if (!config) return reply.code(409).send({ error: 'marketing_meta_not_configured' });
    try {
      if (!await findAd(params.data.adId)) return reply.code(404).send({ error: 'creative_not_found' });
      return reply.header('Cache-Control', 'no-store').redirect(await getMetaCreativePreview(config, params.data.adId));
    } catch { return reply.code(503).send({ error: 'marketing_preview_unavailable' }); }
  });
}

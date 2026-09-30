import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminOwner } from '../auth.js';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { commentsConfig } from '../../social-comments/config.js';
import { organicResults, resolveOrganicResult, organicResultMetrics } from '../../marketing/organic/results.js';
import { organicAttributionReport } from '../../marketing/organic/report.js';
import { organicPublicationSummary } from './queries-marketing-organic.js';
import { organicPublicationWindow } from './marketing-organic-period.js';
import { marketingDateWindow } from './marketing-meta.js';
import { MetaCommentError } from '../../social-comments/graph.js';

const base = '/admin/api/marketing/organic/results';
const keySchema = z.object({ key: z.string().regex(/^(publisher:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?:instagram|facebook):\d{1,40}(?:_\d{1,40})?)$/) }).strict();
const periodSchema = z.object({ period: z.enum(['7d', '30d']).default('30d') }).strict();
const detailSchema = z.object({ window: z.enum(['7d', '30d']).default('7d'),
  network: z.enum(['all', 'instagram', 'facebook']).default('all') }).strict();
const metricsSchema = z.object({ days: z.enum(['7', '30']).default('7'),
  refresh: z.enum(['true', 'false']).default('false') }).strict();
function safeError(error: unknown) {
  return error instanceof MetaCommentError && ['meta_post_owner_mismatch', 'meta_account_not_allowed'].includes(error.code);
}
export async function registerMarketingOrganicResults(app: FastifyInstance) {
  const options = { preHandler: requireAdminOwner };
  app.get(base, options, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const query = periodSchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_query' });
    try {
      const period = marketingDateWindow(query.data.period);
      return { ...await organicResults(pool, env.FAREJADOR_ENV, commentsConfig(), period.since), period };
    } catch { return reply.code(503).send({ error: 'organic_results_unavailable' }); }
  });
  app.get(`${base}/:key`, options, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const params = keySchema.safeParse(request.params), query = detailSchema.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: 'invalid_params' });
    try {
      const publication = await resolveOrganicResult(pool, env.FAREJADOR_ENV, commentsConfig(), params.data.key);
      if (!publication) return reply.code(404).send({ error: 'organic_publication_not_found' });
      const references = publication.deliveries.filter(d => d.status === 'published' && d.post_id &&
        (query.data.network === 'all' || d.platform === query.data.network));
      let summary: any = { available: false, comments: null, series: [] };
      let attribution: Record<string, unknown> = { status: 'disabled',
        period: organicPublicationWindow(publication.published_at, query.data.window) };
      if (references.length) {
        const first = references[0]!;
        try { summary = await organicPublicationSummary(pool, env.FAREJADOR_ENV,
          first.platform, first.account_id, first.post_id, references); } catch { /* Ausente != zero. */ }
        if (env.ORGANIC_ATTRIBUTION_ENABLED) {
          try { attribution = await organicAttributionReport(pool, env.FAREJADOR_ENV, first.platform,
            first.account_id, first.post_id, publication.published_at, query.data.window, references); }
          catch { attribution.status = 'unavailable'; }
        }
      }
      return { publication, summary, attribution, fetched_at: new Date().toISOString() };
    } catch (error) { return reply.code(safeError(error) ? 404 : 503).send({ error: 'organic_publication_unavailable' }); }
  });
  app.get(`${base}/:key/metrics`, options, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const params = keySchema.safeParse(request.params), query = metricsSchema.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: 'invalid_params' });
    try {
      const config = commentsConfig();
      const publication = await resolveOrganicResult(pool, env.FAREJADOR_ENV, config, params.data.key);
      if (!publication) return reply.code(404).send({ error: 'organic_publication_not_found' });
      return await organicResultMetrics(pool, env.FAREJADOR_ENV, config, publication,
        query.data.days === '30' ? 30 : 7, query.data.refresh === 'true');
    } catch (error) { return reply.code(safeError(error) ? 404 : 503).send({ error: 'organic_insights_unavailable' }); }
  });
}

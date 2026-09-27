import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminOwner } from '../auth.js';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { commentsConfig } from '../../social-comments/config.js';
import { PublicationsGraph, readPublications } from '../../social-comments/publications.js';
import { MetaCommentError } from '../../social-comments/graph.js';
import { marketingDateWindow } from './marketing-meta.js';
import { organicPublicationSummary } from './queries-marketing-organic.js';
import { organicPublicationWindow } from './marketing-organic-period.js';
import { organicAttributionReport } from '../../marketing/organic/report.js';
import { organicInsights } from '../../marketing/organic/insights.js';
import { registerOrganicControls } from './route-marketing-organic-controls.js';

const listQuery = z.object({ period: z.enum(['7d', '30d']).default('30d') }).strict();
const detailQuery = z.object({ window: z.enum(['7d', '30d']).default('7d') }).strict();
const insightsQuery = z.object({ refresh: z.enum(['true', 'false']).default('false') }).strict();
const postParams = z.object({ platform: z.enum(['facebook', 'instagram']),
  postId: z.string().regex(/^\d{1,40}(?:_\d{1,40})?$/) }).strict();

export async function registerMarketingOrganic(fastify: FastifyInstance): Promise<void> {
  await registerOrganicControls(fastify);
  const options = { preHandler: requireAdminOwner };
  fastify.get('/admin/api/marketing/organic/publications/:platform/:postId/insights',options,async(request,reply)=>{
    const parsed=postParams.safeParse(request.params);
    if(!parsed.success)return reply.code(400).send({error:'invalid_params'});
    const query=insightsQuery.safeParse(request.query);
    if(!query.success)return reply.code(400).send({error:'invalid_query'});
    const {platform,postId}=parsed.data,config=commentsConfig(),account=platform==='instagram'?config.instagramId:config.pageId;
    if(!account)return reply.code(409).send({error:'organic_not_configured'});
    try{return reply.header('Cache-Control','no-store').send(await organicInsights(config,platform,account,postId,query.data.refresh==='true'));}
    catch{return reply.code(503).send({error:'organic_insights_unavailable'});}
  });
  fastify.get('/admin/api/marketing/organic/publications', options, async (request, reply) => {
    const query = listQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_query' });
    try {
      const period = marketingDateWindow(query.data.period);
      const snapshot = await readPublications(commentsConfig(), env.FAREJADOR_ENV, period.since);
      return reply.header('Cache-Control', 'no-store').send({ ...snapshot, period,
        rows: snapshot.rows.filter(row => Date.parse(row.published_at) <= Date.now()) });
    } catch { return reply.code(503).send({ error: 'organic_publications_unavailable' }); }
  });
  fastify.get('/admin/api/marketing/organic/publications/:platform/:postId', options, async (request, reply) => {
    const params = postParams.safeParse(request.params);
    const query = detailQuery.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: 'invalid_params' });
    const config = commentsConfig();
    const { platform, postId } = params.data;
    const account = platform === 'facebook' ? config.pageId : config.instagramId;
    if (!account || !config.token) return reply.code(409).send({ error: 'organic_not_configured' });
    try {
      const publication = await new PublicationsGraph(config).publication(platform, account, postId);
      let summary;
      try { summary = await organicPublicationSummary(pool, env.FAREJADOR_ENV, platform, account, postId); }
      catch { summary = { available: false, comments: null, series: [] }; }
      let attribution:Record<string,unknown> = { status: 'disabled', period: organicPublicationWindow(publication.published_at, query.data.window),
          private_messages: null, conversations: null, converted_conversations: null, sales: null, revenue: null,
          sales_series: null, conversation_series: null, sales_rows: null, sales_rows_complete: false,
          private_replied: null, private_failed: null, private_failures: null,
          median_confirmation_minutes: null, confirmation_time_buckets: null };
      if(env.ORGANIC_ATTRIBUTION_ENABLED) {
        try {attribution=await organicAttributionReport(pool,env.FAREJADOR_ENV,platform,account,postId,publication.published_at,query.data.window);}
        catch {attribution.status='unavailable';}
      }
      return reply.header('Cache-Control', 'no-store').send({ publication, summary,attribution,
        fetched_at: new Date().toISOString() });
    } catch (error) {
      if (error instanceof MetaCommentError && ['meta_post_owner_mismatch', 'meta_account_not_allowed'].includes(error.code)) {
        return reply.code(404).send({ error: 'organic_publication_not_found' });
      }
      return reply.code(503).send({ error: 'organic_publication_unavailable' });
    }
  });
}

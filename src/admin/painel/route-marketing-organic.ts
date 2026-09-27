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

const listQuery = z.object({ period: z.enum(['7d', '30d']).default('30d') }).strict();
const postParams = z.object({ platform: z.enum(['facebook', 'instagram']),
  postId: z.string().regex(/^\d{1,40}(?:_\d{1,40})?$/) }).strict();

export async function registerMarketingOrganic(fastify: FastifyInstance): Promise<void> {
  const options = { preHandler: requireAdminOwner };
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
    if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
    const config = commentsConfig();
    const { platform, postId } = params.data;
    const account = platform === 'facebook' ? config.pageId : config.instagramId;
    if (!account || !config.token) return reply.code(409).send({ error: 'organic_not_configured' });
    try {
      const publication = await new PublicationsGraph(config).publication(platform, account, postId);
      let summary;
      try { summary = await organicPublicationSummary(pool, env.FAREJADOR_ENV, platform, account, postId); }
      catch { summary = { available: false, comments: null, series: [] }; }
      return reply.header('Cache-Control', 'no-store').send({ publication, summary,
        attribution: { status: 'not_implemented', private_messages: null, conversations: null, sales: null, revenue: null },
        fetched_at: new Date().toISOString() });
    } catch (error) {
      if (error instanceof MetaCommentError && ['meta_post_owner_mismatch', 'meta_account_not_allowed'].includes(error.code)) {
        return reply.code(404).send({ error: 'organic_publication_not_found' });
      }
      return reply.code(503).send({ error: 'organic_publication_unavailable' });
    }
  });
}

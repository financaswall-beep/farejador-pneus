import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAdminContext, requireAdminOwner } from '../auth.js';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { commentsDashboard } from '../../social-comments/dashboard.js';
import { commentsConfig } from '../../social-comments/config.js';
import { CommentsGraph, MetaCommentError } from '../../social-comments/graph.js';
import { recordMarketingAudit } from './marketing-audit.js';

export async function registerMarketingComments(fastify: FastifyInstance): Promise<void> {
  const options = {preHandler:requireAdminOwner};
  fastify.get('/admin/api/marketing/comments',options,async(request,reply)=>{
    const query = z.object({page:z.coerce.number().int().min(1).max(100000).default(1)}).strict().safeParse(request.query);
    if (!query.success) return reply.code(400).send({error:'invalid_query'});
    try { return await commentsDashboard(pool,query.data.page); }
    catch { return reply.code(503).send({error:'comments_unavailable'}); }
  });
  fastify.post('/admin/api/marketing/comments/connection',options,async(_request,reply)=>{
    try { return await new CommentsGraph(commentsConfig()).health(); }
    catch(error) {
      return reply.code(502).send(error instanceof MetaCommentError
        ? {error:error.code,stage:error.stage} : {error:'connection_check_failed'});
    }
  });
  fastify.post('/admin/api/marketing/comments/pause',options,async(request,reply)=>{
    const body = z.object({paused:z.boolean()}).strict().safeParse(request.body);
    if (!body.success) return reply.code(400).send({error:'invalid_body'});
    try {
      const actor = getAdminContext(request).displayName;
      await pool.query(`INSERT INTO ops.meta_comment_controls(environment,paused,updated_by) VALUES($1,$2,$3)
        ON CONFLICT(environment) DO UPDATE SET paused=excluded.paused,updated_by=excluded.updated_by,updated_at=now()`,
      [env.FAREJADOR_ENV,body.data.paused,actor]);
      await recordMarketingAudit({eventType:body.data.paused ? 'comments_paused' : 'comments_resumed',
        actorLabel:actor,entityTable:'ops.meta_comment_controls',payload:body.data});
      return {ok:true,paused:body.data.paused};
    } catch { return reply.code(503).send({error:'comments_unavailable'}); }
  });
}

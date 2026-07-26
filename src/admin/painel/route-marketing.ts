/**
 * Marketing da matriz — endpoint owner-only e read-only.
 * Falha da plataforma externa aparece no payload; nunca derruba outras abas.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminOwner } from '../auth.js';
import { logger } from '../../shared/logger.js';
import {
  getMarketingCampaigns,
  getMarketingIntegrations,
  getMarketingJourneys,
  getMarketingOverview,
} from './queries.js';

const querySchema = z.object({
  period: z.enum(['7d', '30d']).default('30d'),
}).strict();

const campaignQuerySchema = z.object({
  period: z.enum(['7d', '30d']).default('30d'),
  channel: z.enum(['all', 'meta', 'google', 'tiktok']).default('all'),
}).strict();

export async function registerPainelMarketing(fastify: FastifyInstance): Promise<void> {
  fastify.get('/admin/api/marketing/overview', { preHandler: requireAdminOwner }, async (request, reply) => {
    const parsed = querySchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_query' });
    try {
      return reply.status(200).send(await getMarketingOverview(parsed.data.period));
    } catch (err) {
      logger.error({ err }, 'painel marketing overview failed');
      return reply.status(500).send({ error: 'internal_error' });
    }
  });

  fastify.get('/admin/api/marketing/campaigns', { preHandler: requireAdminOwner }, async (request, reply) => {
    const parsed = campaignQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_query' });
    try {
      return reply.status(200).send(await getMarketingCampaigns(parsed.data.period, parsed.data.channel));
    } catch (err) {
      logger.error({ err }, 'painel marketing campaigns failed');
      return reply.status(500).send({ error: 'internal_error' });
    }
  });

  fastify.get('/admin/api/marketing/integrations', { preHandler: requireAdminOwner }, async (request, reply) => {
    const parsed = querySchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_query' });
    try {
      return reply.status(200).send(await getMarketingIntegrations(parsed.data.period));
    } catch (err) {
      logger.error({ err }, 'painel marketing integrations failed');
      return reply.status(500).send({ error: 'internal_error' });
    }
  });

  fastify.get('/admin/api/marketing/journeys', { preHandler: requireAdminOwner }, async (request, reply) => {
    const parsed = querySchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_query' });
    try {
      return reply.status(200).send(await getMarketingJourneys(parsed.data.period));
    } catch (err) {
      logger.error({ err }, 'painel marketing journeys failed');
      return reply.status(500).send({ error: 'internal_error' });
    }
  });
}

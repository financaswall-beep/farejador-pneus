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
import { syncMetaInsights } from '../../marketing/meta-sync.js';
import { reconcileMarketingAttributions } from '../../marketing/attribution.js';
import { enqueueCapiPurchases, pollCapiOutbox } from '../../marketing/capi.js';
import { env } from '../../shared/config/env.js';

const querySchema = z.object({
  period: z.enum(['7d', '30d']).default('30d'),
}).strict();

const campaignQuerySchema = z.object({
  period: z.enum(['7d', '30d']).default('30d'),
  channel: z.enum(['all', 'meta', 'google', 'tiktok']).default('all'),
}).strict();

const syncBodySchema = z.object({
  lookback_days: z.union([z.literal(7), z.literal(60)]).default(60),
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

  fastify.post('/admin/api/marketing/sync', { preHandler: requireAdminOwner }, async (request, reply) => {
    const parsed = syncBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body' });
    try {
      const result = await syncMetaInsights({
        triggerType: 'manual',
        lookbackDays: parsed.data.lookback_days,
      });
      return reply.status(200).send(result);
    } catch (err) {
      logger.error({ err }, 'painel marketing manual sync failed');
      return reply.status(503).send({ error: 'marketing_sync_failed' });
    }
  });

  fastify.post('/admin/api/marketing/reconcile', { preHandler: requireAdminOwner }, async (_request, reply) => {
    try {
      const attribution = await reconcileMarketingAttributions();
      const capi_enqueued = await enqueueCapiPurchases();
      return reply.status(200).send({ attribution, capi_enqueued });
    } catch (err) {
      logger.error({ err }, 'painel marketing attribution reconcile failed');
      return reply.status(503).send({ error: 'marketing_reconcile_failed' });
    }
  });

  fastify.post('/admin/api/marketing/capi/test', { preHandler: requireAdminOwner }, async (_request, reply) => {
    if (!env.META_CAPI_TEST_EVENT_CODE) {
      return reply.status(409).send({ error: 'capi_test_event_code_not_configured' });
    }
    try {
      const enqueued = await enqueueCapiPurchases({ enabled: true });
      const processed = await pollCapiOutbox();
      return reply.status(200).send({ enqueued, processed });
    } catch (err) {
      logger.error({ err }, 'painel marketing CAPI test failed');
      return reply.status(503).send({ error: 'marketing_capi_test_failed' });
    }
  });
}

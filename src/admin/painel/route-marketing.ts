/**
 * Marketing da matriz — leitura e ações operacionais owner-only.
 * Falha da plataforma externa aparece no payload; nunca derruba outras abas.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAdminContext, requireAdminOwner } from '../auth.js';
import { logger } from '../../shared/logger.js';
import {
  getMarketingCampaignDetail,
  getMarketingCampaigns,
  getMarketingIntegrations,
  getMarketingJourneys,
  getMarketingOverview,
} from './queries.js';
import { syncMetaInsights } from '../../marketing/meta-sync.js';
import { reconcileMarketingAttributions } from '../../marketing/attribution.js';
import { enqueueCapiPurchases } from '../../marketing/capi.js';
import {
  sendLatestCapiTestPurchase,
  sendLatestWhatsappReferralTestPurchase,
} from '../../marketing/capi-test.js';
import { env } from '../../shared/config/env.js';
import { recordMarketingAudit } from './marketing-audit.js';
import { setCampaignScope } from '../../marketing/campaign-scope.js';

const querySchema = z.object({
  period: z.enum(['7d', '30d']).default('30d'),
}).strict();

const campaignQuerySchema = z.object({
  period: z.enum(['7d', '30d']).default('30d'),
  channel: z.enum(['all', 'meta', 'google', 'tiktok']).default('all'),
}).strict();

const campaignParamsSchema = z.object({
  campaignId: z.string().min(1).max(100),
}).strict();

const campaignScopeParamsSchema = z.object({
  adAccountId: z.string().regex(/^act_[0-9]+$/),
  campaignId: z.string().min(1).max(100),
}).strict();

const campaignScopeBodySchema = z.object({
  scope: z.enum(['pending', 'matrix', 'external']),
  reason: z.string().trim().min(3).max(500),
}).strict();

const syncBodySchema = z.object({
  lookback_days: z.union([z.literal(7), z.literal(60)]).default(60),
}).strict();

function capiFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^meta_capi_[0-9]+(?::.{1,300})?$/.test(message)
    ? message
    : 'marketing_capi_unknown_error';
}

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

  fastify.get('/admin/api/marketing/campaigns/:campaignId', { preHandler: requireAdminOwner }, async (request, reply) => {
    const params = campaignParamsSchema.safeParse(request.params ?? {});
    const query = querySchema.safeParse(request.query ?? {});
    if (!params.success || !query.success) {
      return reply.status(400).send({ error: 'invalid_query' });
    }
    try {
      const detail = await getMarketingCampaignDetail(params.data.campaignId, query.data.period);
      return detail
        ? reply.status(200).send(detail)
        : reply.status(404).send({ error: 'campaign_not_found' });
    } catch (err) {
      logger.error({ err }, 'painel marketing campaign detail failed');
      return reply.status(500).send({ error: 'internal_error' });
    }
  });

  fastify.put(
    '/admin/api/marketing/ad-accounts/:adAccountId/campaigns/:campaignId/scope',
    { preHandler: requireAdminOwner },
    async (request, reply) => {
      const params = campaignScopeParamsSchema.safeParse(request.params ?? {});
      const body = campaignScopeBodySchema.safeParse(request.body ?? {});
      if (!params.success || !body.success) {
        return reply.status(400).send({ error: 'invalid_campaign_scope' });
      }
      try {
        const result = await setCampaignScope({
          adAccountId: params.data.adAccountId,
          campaignId: params.data.campaignId,
          scope: body.data.scope,
          reason: body.data.reason,
          actor: getAdminContext(request).displayName,
          idempotencyKey: String(request.id),
        });
        return reply.status(200).send(result);
      } catch (error) {
        if (error instanceof Error && error.message === 'marketing_campaign_not_found') {
          return reply.status(404).send({ error: 'campaign_not_found' });
        }
        logger.error({ err: error }, 'painel marketing campaign scope failed');
        return reply.status(500).send({ error: 'marketing_campaign_scope_failed' });
      }
    },
  );

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
    if (!env.MARKETING_SYNC_ENABLED) {
      return reply.status(409).send({ error: 'marketing_sync_disabled' });
    }
    try {
      const result = await syncMetaInsights({
        triggerType: 'manual',
        lookbackDays: parsed.data.lookback_days,
      });
      await recordMarketingAudit({
        eventType: 'marketing_sync_manual',
        actorLabel: getAdminContext(request).displayName,
        entityTable: 'marketing.meta_sync_runs',
        entityId: result.run_id,
        idempotencyKey: String(request.id),
        payload: {
          status: 'succeeded',
          lookback_days: parsed.data.lookback_days,
          rows_upserted: result.rows_upserted,
          since: result.since,
          until: result.until,
        },
      });
      return reply.status(200).send(result);
    } catch (err) {
      await recordMarketingAudit({
        eventType: 'marketing_sync_manual',
        actorLabel: getAdminContext(request).displayName,
        entityTable: 'marketing.meta_sync_runs',
        idempotencyKey: String(request.id),
        payload: { status: 'failed', lookback_days: parsed.data.lookback_days },
      });
      logger.error({ err }, 'painel marketing manual sync failed');
      return reply.status(503).send({ error: 'marketing_sync_failed' });
    }
  });

  fastify.post('/admin/api/marketing/reconcile', { preHandler: requireAdminOwner }, async (request, reply) => {
    try {
      const attribution = await reconcileMarketingAttributions();
      const capi_enqueued = await enqueueCapiPurchases();
      await recordMarketingAudit({
        eventType: 'marketing_attribution_reconciled',
        actorLabel: getAdminContext(request).displayName,
        entityTable: 'marketing.order_attributions',
        idempotencyKey: String(request.id),
        payload: { status: 'succeeded', ...attribution, capi_enqueued },
      });
      return reply.status(200).send({ attribution, capi_enqueued });
    } catch (err) {
      await recordMarketingAudit({
        eventType: 'marketing_attribution_reconciled',
        actorLabel: getAdminContext(request).displayName,
        entityTable: 'marketing.order_attributions',
        idempotencyKey: String(request.id),
        payload: { status: 'failed' },
      });
      logger.error({ err }, 'painel marketing attribution reconcile failed');
      return reply.status(503).send({ error: 'marketing_reconcile_failed' });
    }
  });

  fastify.post('/admin/api/marketing/capi/test', { preHandler: requireAdminOwner }, async (request, reply) => {
    if (!env.META_CAPI_TEST_EVENT_CODE) {
      await recordMarketingAudit({
        eventType: 'marketing_capi_test',
        actorLabel: getAdminContext(request).displayName,
        entityTable: 'marketing.capi_test',
        idempotencyKey: String(request.id),
        payload: { status: 'blocked', reason: 'test_event_code_not_configured' },
      });
      return reply.status(409).send({ error: 'capi_test_event_code_not_configured' });
    }
    try {
      const result = await sendLatestCapiTestPurchase();
      await recordMarketingAudit({
        eventType: 'marketing_capi_test',
        actorLabel: getAdminContext(request).displayName,
        entityTable: 'marketing.capi_test',
        idempotencyKey: String(request.id),
        payload: {
          status: result.processed ? 'succeeded' : 'no_eligible_purchase',
          events_received: result.events_received,
        },
      });
      return reply.status(200).send(result);
    } catch (err) {
      const reason = capiFailureReason(err);
      await recordMarketingAudit({
        eventType: 'marketing_capi_test',
        actorLabel: getAdminContext(request).displayName,
        entityTable: 'marketing.capi_test',
        idempotencyKey: String(request.id),
        payload: { status: 'failed', reason },
      });
      logger.error({ err }, 'painel marketing CAPI test failed');
      return reply.status(503).send({ error: 'marketing_capi_test_failed', reason });
    }
  });

  fastify.post('/admin/api/marketing/capi/test/whatsapp', { preHandler: requireAdminOwner }, async (request, reply) => {
    if (!env.META_CAPI_TEST_EVENT_CODE) {
      return reply.status(409).send({ error: 'capi_test_event_code_not_configured' });
    }
    try {
      const result = await sendLatestWhatsappReferralTestPurchase();
      await recordMarketingAudit({
        eventType: 'marketing_capi_whatsapp_test',
        actorLabel: getAdminContext(request).displayName,
        entityTable: 'marketing.capi_test',
        idempotencyKey: String(request.id),
        payload: {
          status: result.processed ? 'succeeded' : 'no_eligible_referral',
          events_received: result.events_received,
          synthetic: true,
        },
      });
      return reply.status(200).send(result);
    } catch (err) {
      const reason = capiFailureReason(err);
      await recordMarketingAudit({
        eventType: 'marketing_capi_whatsapp_test',
        actorLabel: getAdminContext(request).displayName,
        entityTable: 'marketing.capi_test',
        idempotencyKey: String(request.id),
        payload: { status: 'failed', reason, synthetic: true },
      });
      logger.error({ err }, 'painel marketing WhatsApp CAPI test failed');
      return reply.status(503).send({ error: 'marketing_capi_test_failed', reason });
    }
  });
}

import type { FastifyInstance } from 'fastify';
import { registerChatwootWebhookRoutes } from '../webhooks/chatwoot.route.js';
import { registerMetaMessagingWebhookRoutes } from '../webhooks/meta-messaging.route.js';
import { registerHealthRoute } from '../admin/health.route.js';
import { registerReplayRoute } from '../admin/replay.route.js';
import { registerReconcileRoute } from '../admin/reconcile.route.js';
import { registerPainelRoute } from '../admin/painel/route.js';
import { registerParceiroRoute } from '../parceiro/route.js';
import { registerPartnerOperationStockRoutes } from '../parceiro/route-operation-stock.js';
import { registerPartnerOperationStockDetailRoutes } from '../parceiro/route-operation-stock-detail.js';
import { registerPartnerOperationStockUpdateRoutes } from '../parceiro/route-operation-stock-update.js';
import { registerPartnerOperationStockPriceRoutes } from '../parceiro/route-operation-stock-price.js';
import { registerPartnerOperationPurchaseRoutes } from '../parceiro/route-operation-purchases.js';
import { registerPartnerOperationDeliveryRoutes } from '../parceiro/route-operation-deliveries.js';
import { registerPartnerOperationTeamRoutes } from '../parceiro/route-operation-team.js';
import { registerPartnerOperationNotificationRoutes } from '../parceiro/route-operation-notifications.js';
import { registerLoginGlobalRoute } from '../parceiro/login-global.route.js';
import { registerCaixaRoute } from '../admin/caixa/route.js';
import { registerAdminLoginRoute } from '../admin/login.route.js';
import { registerPublicLegalRoutes } from '../public/legal.route.js';

export async function registerRoutes(fastify: FastifyInstance): Promise<void> {
  await registerChatwootWebhookRoutes(fastify);
  await registerMetaMessagingWebhookRoutes(fastify);
  await registerHealthRoute(fastify);
  await registerReplayRoute(fastify);
  await registerReconcileRoute(fastify);
  await registerAdminLoginRoute(fastify);
  await registerPublicLegalRoutes(fastify);
  await registerPainelRoute(fastify);
  await registerParceiroRoute(fastify);
  registerPartnerOperationStockRoutes(fastify);
  registerPartnerOperationStockDetailRoutes(fastify);
  registerPartnerOperationStockUpdateRoutes(fastify);
  registerPartnerOperationStockPriceRoutes(fastify);
  registerPartnerOperationPurchaseRoutes(fastify);
  registerPartnerOperationDeliveryRoutes(fastify);
  registerPartnerOperationTeamRoutes(fastify);
  registerPartnerOperationNotificationRoutes(fastify);
  // Porta única de login (/login) — 0095. Aditiva: o login por slug continua.
  await registerLoginGlobalRoute(fastify);
  // Operação da Loja (/operacao) — Matriz e parceiros; URLs antigas redirecionam.
  await registerCaixaRoute(fastify);
}

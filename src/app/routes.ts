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
import { registerLoginGlobalRoute } from '../parceiro/login-global.route.js';
import { registerEntregadorRoute } from '../admin/entregador/route.js';
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
  // Porta única de login (/login) — 0095. Aditiva: o login por slug continua.
  await registerLoginGlobalRoute(fastify);
  // Portal do entregador (/entregas) — 0125. Dormente atrás de MATRIZ_ENTREGADOR_PORTAL.
  await registerEntregadorRoute(fastify);
  // Frente de Caixa da Matriz (/caixa) — login móvel isolado do admin e da logística.
  await registerCaixaRoute(fastify);
}

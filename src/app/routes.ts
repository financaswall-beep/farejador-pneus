import type { FastifyInstance } from 'fastify';
import { registerChatwootWebhookRoutes } from '../webhooks/chatwoot.route.js';
import { registerHealthRoute } from '../admin/health.route.js';
import { registerReplayRoute } from '../admin/replay.route.js';
import { registerReconcileRoute } from '../admin/reconcile.route.js';
import { registerPainelRoute } from '../admin/painel/route.js';
import { registerParceiroRoute } from '../parceiro/route.js';
import { registerLoginGlobalRoute } from '../parceiro/login-global.route.js';
import { registerEntregadorRoute } from '../admin/entregador/route.js';
import { registerAdminLoginRoute } from '../admin/login.route.js';

export async function registerRoutes(fastify: FastifyInstance): Promise<void> {
  await registerChatwootWebhookRoutes(fastify);
  await registerHealthRoute(fastify);
  await registerReplayRoute(fastify);
  await registerReconcileRoute(fastify);
  await registerAdminLoginRoute(fastify);
  await registerPainelRoute(fastify);
  await registerParceiroRoute(fastify);
  // Porta única de login (/login) — 0095. Aditiva: o login por slug continua.
  await registerLoginGlobalRoute(fastify);
  // Portal do entregador (/entregas) — 0125. Dormente atrás de MATRIZ_ENTREGADOR_PORTAL.
  await registerEntregadorRoute(fastify);
}

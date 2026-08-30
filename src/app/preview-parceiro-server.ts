/**
 * Servidor ENXUTO só pro Portal Parceiro — uso em preview/dev local.
 *
 * Diferente de src/app/server.ts: NÃO liga os workers do atendente nem da
 * normalização (zero efeito colateral em prod). Só registra a rota do painel
 * do parceiro e fica servindo o front estático + API read/write do portal.
 *
 * Rodar: npx tsx --env-file=.env src/app/preview-parceiro-server.ts
 */
import Fastify from 'fastify';
import { loggerOptions, logger } from '../shared/logger.js';
import { partnerPool } from '../parceiro/db.js';
import { registerParceiroRoute } from '../parceiro/route.js';
import { registerLoginGlobalRoute } from '../parceiro/login-global.route.js';
import { registerPartnerOperationStockRoutes } from '../parceiro/route-operation-stock.js';
import { registerPartnerOperationStockDetailRoutes } from '../parceiro/route-operation-stock-detail.js';
import { registerPartnerOperationStockUpdateRoutes } from '../parceiro/route-operation-stock-update.js';
import { registerPartnerOperationStockPriceRoutes } from '../parceiro/route-operation-stock-price.js';
import { registerPartnerOperationStockSimpleRoutes } from '../parceiro/route-operation-stock-simple.js';
import { registerPartnerOperationPurchaseRoutes } from '../parceiro/route-operation-purchases.js';
import { registerPartnerOperationDeliveryRoutes } from '../parceiro/route-operation-deliveries.js';
import { registerPartnerOperationTeamRoutes } from '../parceiro/route-operation-team.js';
import { registerPartnerOperationNotificationRoutes } from '../parceiro/route-operation-notifications.js';
import { registerCaixaRoute } from '../admin/caixa/route.js';
import { startPartnerChatNotifyHub } from '../normalization/partner-chat.notify.js';
import { createRequestId, registerRequestContext } from '../shared/request-context.js';
import { registerMunicipalityCatalogRoute } from '../network/municipality-catalog.route.js';

const fastify = Fastify({ logger: loggerOptions, genReqId: createRequestId });
registerRequestContext(fastify);

fastify.addContentTypeParser(
  'application/json',
  { parseAs: 'buffer' },
  (request, body, done) => {
    try {
      const rawBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
      (request.raw as typeof request.raw & { rawBody?: Buffer }).rawBody = rawBody;
      done(null, JSON.parse(rawBody.toString()));
    } catch (err) {
      done(err as Error);
    }
  },
);

async function start(): Promise<void> {
  await registerMunicipalityCatalogRoute(fastify);
  await registerParceiroRoute(fastify);
  await registerLoginGlobalRoute(fastify);
  registerPartnerOperationStockRoutes(fastify);
  registerPartnerOperationStockDetailRoutes(fastify);
  registerPartnerOperationStockUpdateRoutes(fastify);
  registerPartnerOperationStockPriceRoutes(fastify);
  registerPartnerOperationStockSimpleRoutes(fastify);
  registerPartnerOperationPurchaseRoutes(fastify);
  registerPartnerOperationDeliveryRoutes(fastify);
  registerPartnerOperationTeamRoutes(fastify);
  registerPartnerOperationNotificationRoutes(fastify);
  await registerCaixaRoute(fastify);
  // Hub de tempo real (Fatia 3): no preview tambem, pra testar SSE local
  // apontando pro banco de prod (.env.preview).
  startPartnerChatNotifyHub();
  const port = Number(process.env.PREVIEW_PORT ?? 4100);
  await fastify.listen({ port, host: '0.0.0.0' });
  fastify.log.info({ port }, 'preview parceiro server listening');
}

async function shutdown(): Promise<void> {
  await fastify.close();
  await partnerPool.end().catch(() => undefined);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

start().catch((err) => {
  logger.error({ err }, 'failed to start preview parceiro server');
  process.exit(1);
});

import Fastify from 'fastify';
import { env } from '../shared/config/env.js';
import { logger, loggerOptions } from '../shared/logger.js';
import { pool } from '../persistence/db.js';
import { registerRoutes } from './routes.js';
import { startWorker } from '../normalization/worker.js';
import { startPartnerChatReconciler } from '../normalization/partner-chat.reconcile.js';
import { startPartnerChatNotifyHub } from '../normalization/partner-chat.notify.js';
import { startAgentV2Worker } from '../atendente-v2/worker.js';
import { startBotOutboxWorker } from '../atendente-v2/outbound-worker.js';
import { startPhotoRequestExpirer } from '../atendente-v2/photo-requests.js';
import { startSatisfactionSurveyWorker } from '../atendente-v2/satisfaction.js';
import { startPartnerPushFanout } from '../parceiro/push.js';
import { registerSecurityHeaders } from './security-headers.js';
import { startClientesKanbanNotifyHub } from '../shared/clientes-kanban.notify.js';
import { costReconciliationOwnershipOk } from '../admin/painel/queries-rede-custos.js';

const fastify = Fastify({
  logger: loggerOptions,
  trustProxy: env.TRUST_PROXY,
});

registerSecurityHeaders(fastify, env.NODE_ENV === 'production');

let stopWorker: (() => void) | null = null;
let stopAgentV2: (() => void) | null = null;
let stopBotOutbox: (() => void) | null = null;
let stopPartnerChatReconciler: (() => void) | null = null;
let stopPhotoExpirer: (() => void) | null = null;
let stopSatisfactionSurvey: (() => void) | null = null;
let stopPartnerPush: (() => void) | null = null;

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
  await registerRoutes(fastify);

  stopWorker = startWorker();
  stopAgentV2 = startAgentV2Worker();
  stopBotOutbox = startBotOutboxWorker();
  stopPartnerChatReconciler = startPartnerChatReconciler();
  // Hub de tempo real do chat (LISTEN partner_chat -> SSE). Fatia 3.
  startPartnerChatNotifyHub();
  // CRM da matriz: invalida o Kanban quando conversa, bot ou pedido mudam.
  startClientesKanbanNotifyHub();
  // Foto sob demanda (0094): expira pendentes + fallback. No-op com a flag off.
  stopPhotoExpirer = startPhotoRequestExpirer();
  // Pesquisa de satisfação (0105): dispara nas finalizações + expira. No-op com a flag off.
  stopSatisfactionSurvey = startSatisfactionSurveyWorker();
  // Push (PWA, 0109): escuta global do partner_chat -> notificação nativa no
  // celular do borracheiro (foto/pedido com navegador fechado). No-op com a flag off.
  stopPartnerPush = startPartnerPushFanout();

  const port = env.PORT;
  await fastify.listen({ port, host: '0.0.0.0' });
  fastify.log.info({ port }, 'server listening');

  // Marcador da Etapa 6: o guard da 0137 só deixa reconciliar custo quando a
  // conexão é a DONA de commerce.partner_order_items. Se a blindagem futura
  // trocar a role do app, este aviso grita no boot — sem travar o servidor.
  void costReconciliationOwnershipOk()
    .then((ok) => {
      if (!ok) {
        fastify.log.error(
          'RECONCILIACAO DE CUSTO INOPERANTE: a conexao atual nao e a dona de commerce.partner_order_items (guard da 0137). O POST /admin/api/rede/custos/reconcile vai responder 503 ate a conexao voltar a ser o owner.',
        );
      }
    })
    .catch((err) => {
      fastify.log.warn({ err }, 'checagem de ownership da reconciliacao falhou; boot segue normal');
    });
}

async function shutdown(signal: string): Promise<void> {
  fastify.log.info({ signal }, 'shutting down gracefully');
  stopWorker?.();
  stopAgentV2?.();
  stopBotOutbox?.();
  stopPartnerChatReconciler?.();
  stopPhotoExpirer?.();
  stopSatisfactionSurvey?.();
  stopPartnerPush?.();
  await fastify.close();
  await pool.end();
  fastify.log.info('shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('uncaughtException', (err) => {
  if (err.message.includes('Connection terminated unexpectedly')) {
    logger.error({ err }, 'postgres connection terminated unexpectedly; keeping local server alive');
    return;
  }

  logger.error({ err }, 'uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'unhandled rejection');
});

start().catch((err) => {
  logger.error({ err }, 'failed to start server');
  process.exit(1);
});

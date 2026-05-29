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

const fastify = Fastify({ logger: loggerOptions });

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
  await registerParceiroRoute(fastify);
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

/**
 * Servidor ENXUTO só pro Painel da Matriz (/admin/painel) — uso em preview/dev.
 *
 * Igual ao preview-parceiro-server.ts: NÃO liga os workers do atendente nem da
 * normalização (zero efeito colateral em prod). Só registra a rota do painel
 * admin/matriz e serve o front estático + as APIs de leitura/escrita do painel.
 *
 * Rodar (apontando pra prod): npx tsx --env-file=.env.preview src/app/preview-matriz-server.ts
 */
import Fastify from 'fastify';
import { loggerOptions, logger } from '../shared/logger.js';
import { pool } from '../persistence/db.js';
import { registerPainelRoute } from '../admin/painel/route.js';
import { registerEntregadorRoute } from '../admin/entregador/route.js';
// 0132: o painel autentica por login humano + cookie — sem esta rota o preview
// não tem como logar (o front não usa mais bearer).
import { registerAdminLoginRoute } from '../admin/login.route.js';
import { startClientesKanbanNotifyHub } from '../shared/clientes-kanban.notify.js';

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
  await registerAdminLoginRoute(fastify);
  await registerPainelRoute(fastify);
  await registerEntregadorRoute(fastify);
  startClientesKanbanNotifyHub();
  const port = Number(process.env.PREVIEW_MATRIZ_PORT ?? 4200);
  await fastify.listen({ port, host: '0.0.0.0' });
  fastify.log.info({ port }, 'preview matriz server listening');
}

async function shutdown(): Promise<void> {
  await fastify.close();
  await pool.end().catch(() => undefined);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

start().catch((err) => {
  logger.error({ err }, 'failed to start preview matriz server');
  process.exit(1);
});

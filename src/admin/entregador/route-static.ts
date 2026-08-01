import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

type FlagGate = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
const publicDir = path.join(process.cwd(), 'painel', 'public');

async function sendStatic(
  reply: FastifyReply,
  file: string,
  type: string,
  cacheControl = 'no-store',
): Promise<FastifyReply> {
  const content = await readFile(path.join(publicDir, file));
  return reply.header('Content-Type', type).header('Cache-Control', cacheControl).send(content);
}

/** Arquivos do portal, todos atrás da mesma flag que protege as APIs. */
export function registerEntregadorStaticRoutes(fastify: FastifyInstance, flagGate: FlagGate): void {
  const text = (url: string, file: string, type: string) =>
    fastify.get(url, { preHandler: flagGate }, async (_request, reply) => sendStatic(reply, file, type));
  const asset = (url: string, file: string, type: string) =>
    fastify.get(url, { preHandler: flagGate }, async (_request, reply) =>
      sendStatic(reply, `assets/${file}`, type, 'public, max-age=31536000, immutable'));

  text('/entregas', 'entregas.html', 'text/html; charset=utf-8');
  text('/entregas.js', 'entregas.js', 'text/javascript; charset=utf-8');
  text('/entregas.card-actions.js', 'entregas.card-actions.js', 'text/javascript; charset=utf-8');
  text('/tailwind.css', 'tailwind.css', 'text/css; charset=utf-8');

  asset('/entregas/hero-fiorino-galpao-v5.webp', 'entregas-login-fiorino-galpao-v5.webp', 'image/webp');
  asset('/entregas/finalizar-rota-curva-v1.webp', 'entregas-finalizar-rota-curva-v1.webp', 'image/webp');
  asset('/entregas/icon-waze-v1.png', 'navigation-waze-official-v1.png', 'image/png');
  asset('/entregas/icon-google-maps-v1.png', 'navigation-google-maps-official-v1.png', 'image/png');
  asset('/entregas/icon-whatsapp-v1.png', 'navigation-whatsapp-official-v1.png', 'image/png');
  asset('/entregas/button-whatsapp-v2.webp', 'navigation-whatsapp-button-art-v2.webp', 'image/webp');
  asset('/entregas/button-waze-v2.webp', 'navigation-waze-button-art-v2.webp', 'image/webp');
  asset('/entregas/button-google-maps-v4.webp', 'navigation-google-maps-button-art-v4.webp', 'image/webp');
  asset('/entregas/button-google-maps-v5.webp', 'navigation-google-maps-button-art-v5.webp', 'image/webp');
}

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';

const publicDir = path.join(process.cwd(), 'painel', 'public');

async function sendPublicFile(
  reply: FastifyReply,
  file: string,
  contentType: string,
  cacheControl: string,
) {
  const content = await readFile(path.join(publicDir, file));
  return reply
    .header('Content-Type', contentType)
    .header('Cache-Control', cacheControl)
    .send(content);
}

/** Páginas públicas exigidas pela Meta para publicação do aplicativo. */
export async function registerPublicLegalRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/politica-de-privacidade', async (_request, reply) =>
    sendPublicFile(reply, 'legal/politica-de-privacidade.html', 'text/html; charset=utf-8', 'public, max-age=300'));

  fastify.get('/termos-de-servico', async (_request, reply) =>
    sendPublicFile(reply, 'legal/termos-de-servico.html', 'text/html; charset=utf-8', 'public, max-age=300'));

  fastify.get('/exclusao-de-dados', async (_request, reply) =>
    sendPublicFile(reply, 'legal/exclusao-de-dados.html', 'text/html; charset=utf-8', 'public, max-age=300'));

  fastify.get('/legal/2w.css', async (_request, reply) =>
    sendPublicFile(reply, 'legal/2w.css', 'text/css; charset=utf-8', 'public, max-age=86400'));

  fastify.get('/assets/2w-app-icon-1024.png', async (_request, reply) =>
    sendPublicFile(
      reply,
      'assets/2w-app-icon-1024.png',
      'image/png',
      'public, max-age=31536000, immutable',
    ));
}

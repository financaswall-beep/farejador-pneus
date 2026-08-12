import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

type FlagGate = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
const publicDir = path.join(process.cwd(), 'painel', 'public');
const partnerAssetsDir = path.join(process.cwd(), 'parceiro', 'public', 'assets');

async function sendStatic(
  reply: FastifyReply,
  file: string,
  type: string,
  cacheControl = 'no-store',
): Promise<FastifyReply> {
  const content = await readFile(path.join(publicDir, file));
  return reply.header('Content-Type', type).header('Cache-Control', cacheControl).send(content);
}

export function registerCaixaStaticRoutes(fastify: FastifyInstance, flagGate: FlagGate): void {
  const text = (url: string, file: string, type: string, cacheControl = 'no-store') =>
    fastify.get(url, { preHandler: flagGate }, async (_request, reply) =>
      sendStatic(reply, file, type, cacheControl));

  text('/caixa', 'caixa.html', 'text/html; charset=utf-8');
  text('/caixa/', 'caixa.html', 'text/html; charset=utf-8');
  for (const url of ['/vendas', '/caixa/vendas']) {
    fastify.get(url, { preHandler: flagGate }, async (_request, reply) =>
      reply.header('Cache-Control', 'no-store').redirect('/caixa#vendas'));
  }
  text('/caixa/caixa.css', 'caixa.css', 'text/css; charset=utf-8', 'public, max-age=86400');
  text('/caixa/caixa-core.js', 'caixa-core.js', 'text/javascript; charset=utf-8');
  text('/caixa/caixa-modules.js', 'caixa-modules.js', 'text/javascript; charset=utf-8');
  text('/caixa/caixa-checkout-catalog.js', 'caixa-checkout-catalog.js', 'text/javascript; charset=utf-8');
  text('/caixa/caixa-checkout.js', 'caixa-checkout.js', 'text/javascript; charset=utf-8');
  text('/caixa/caixa-checkout-session.js', 'caixa-checkout-session.js', 'text/javascript; charset=utf-8');
  text('/caixa/caixa-sales-view.js', 'caixa-sales-view.js', 'text/javascript; charset=utf-8');
  text('/caixa/caixa-stock-view.js', 'caixa-stock-view.js', 'text/javascript; charset=utf-8');
  text('/caixa/caixa-stock-detail.js', 'caixa-stock-detail.js', 'text/javascript; charset=utf-8');
  text('/caixa/caixa-stock-edit.js', 'caixa-stock-edit.js', 'text/javascript; charset=utf-8');
  text('/caixa/caixa-stock.js', 'caixa-stock.js', 'text/javascript; charset=utf-8');
  text('/caixa/caixa-stock-count.js', 'caixa-stock-count.js', 'text/javascript; charset=utf-8');
  text('/caixa/caixa-stock-receipts.js', 'caixa-stock-receipts.js', 'text/javascript; charset=utf-8');
  text('/caixa/caixa-sales.js', 'caixa-sales.js', 'text/javascript; charset=utf-8');
  text('/caixa/caixa-deliveries-matrix.js', 'caixa-deliveries-matrix.js', 'text/javascript; charset=utf-8');
  text('/caixa/caixa-deliveries.js', 'caixa-deliveries.js', 'text/javascript; charset=utf-8');
  text('/caixa/caixa-profile.js', 'caixa-profile.js', 'text/javascript; charset=utf-8');
  text('/caixa/caixa-photo.js', 'caixa-photo.js', 'text/javascript; charset=utf-8');
  text('/caixa/caixa.js', 'caixa.js', 'text/javascript; charset=utf-8');
  fastify.get('/caixa/som-pedido-novo.mp3', { preHandler: flagGate }, async (_request, reply) => {
    const content = await readFile(path.join(partnerAssetsDir, 'som-pedido-novo.mp3'));
    return reply.header('Content-Type', 'audio/mpeg')
      .header('Cache-Control', 'public, max-age=31536000, immutable').send(content);
  });
  text(
    '/caixa/logo-2w.svg',
    'assets/2w-app-icon-1024.svg',
    'image/svg+xml',
    'public, max-age=31536000, immutable',
  );
  text(
    '/caixa/hero-atendente-v1.webp',
    'assets/caixa-login-atendente-v1.webp',
    'image/webp',
    'public, max-age=31536000, immutable',
  );
  text(
    '/caixa/catalog-tire.webp',
    'assets/catalog-tire.webp',
    'image/webp',
    'public, max-age=31536000, immutable',
  );
  text(
    '/caixa/vendas-hero.webp',
    'assets/vendas-hero.webp',
    'image/webp',
    'public, max-age=31536000, immutable',
  );
}

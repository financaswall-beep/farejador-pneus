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

  text('/operacao', 'caixa.html', 'text/html; charset=utf-8');
  text('/operacao/', 'caixa.html', 'text/html; charset=utf-8');
  for (const url of ['/caixa', '/caixa/', '/vendas', '/caixa/vendas']) {
    fastify.get(url, { preHandler: flagGate }, async (_request, reply) =>
      reply.header('Cache-Control', 'no-store').redirect('/operacao#vendas'));
  }
  for (const url of ['/entregas', '/entregas/']) {
    fastify.get(url, { preHandler: flagGate }, async (_request, reply) =>
      reply.header('Cache-Control', 'no-store').redirect('/operacao#entregas'));
  }
  text('/operacao/caixa.css', 'caixa.css', 'text/css; charset=utf-8', 'public, max-age=86400');
  text('/operacao/caixa-core.js', 'caixa-core.js', 'text/javascript; charset=utf-8');
  text('/operacao/caixa-modules.js', 'caixa-modules.js', 'text/javascript; charset=utf-8');
  text('/operacao/caixa-checkout-catalog.js', 'caixa-checkout-catalog.js', 'text/javascript; charset=utf-8');
  text('/operacao/caixa-checkout-pricing.js', 'caixa-checkout-pricing.js', 'text/javascript; charset=utf-8');
  text('/operacao/caixa-checkout.js', 'caixa-checkout.js', 'text/javascript; charset=utf-8');
  text('/operacao/caixa-checkout-session.js', 'caixa-checkout-session.js', 'text/javascript; charset=utf-8');
  text('/operacao/caixa-sales-weekly.js', 'caixa-sales-weekly.js', 'text/javascript; charset=utf-8');
  text('/operacao/caixa-sales-view.js', 'caixa-sales-view.js', 'text/javascript; charset=utf-8');
  text('/operacao/caixa-stock-view.js', 'caixa-stock-view.js', 'text/javascript; charset=utf-8');
  text('/operacao/caixa-stock-detail.js', 'caixa-stock-detail.js', 'text/javascript; charset=utf-8');
  text('/operacao/caixa-stock-price.js', 'caixa-stock-price.js', 'text/javascript; charset=utf-8');
  text('/operacao/caixa-stock-edit.js', 'caixa-stock-edit.js', 'text/javascript; charset=utf-8');
  text('/operacao/caixa-stock.js', 'caixa-stock.js', 'text/javascript; charset=utf-8');
  text('/operacao/caixa-stock-count.js', 'caixa-stock-count.js', 'text/javascript; charset=utf-8');
  text('/operacao/caixa-stock-receipts.js', 'caixa-stock-receipts.js', 'text/javascript; charset=utf-8');
  text('/operacao/caixa-sales.js', 'caixa-sales.js', 'text/javascript; charset=utf-8');
  text('/operacao/caixa-deliveries-matrix.js', 'caixa-deliveries-matrix.js', 'text/javascript; charset=utf-8');
  text('/operacao/caixa-deliveries.js', 'caixa-deliveries.js', 'text/javascript; charset=utf-8');
  text('/operacao/caixa-finance.js', 'caixa-finance.js', 'text/javascript; charset=utf-8');
  text('/operacao/caixa-finance-entries.js', 'caixa-finance-entries.js', 'text/javascript; charset=utf-8');
  text('/operacao/caixa-finance-commissions.js', 'caixa-finance-commissions.js', 'text/javascript; charset=utf-8');
  text('/operacao/caixa-finance-commission-detail.js', 'caixa-finance-commission-detail.js', 'text/javascript; charset=utf-8');
  text('/operacao/caixa-team.js', 'caixa-team.js', 'text/javascript; charset=utf-8');
  text('/operacao/caixa-team-remuneration.js', 'caixa-team-remuneration.js', 'text/javascript; charset=utf-8');
  text('/operacao/caixa-team-commission.js', 'caixa-team-commission.js', 'text/javascript; charset=utf-8');
  text('/operacao/caixa-team-permissions.js', 'caixa-team-permissions.js', 'text/javascript; charset=utf-8');
  text('/operacao/caixa-profile.js', 'caixa-profile.js', 'text/javascript; charset=utf-8');
  text('/operacao/caixa-photo.js', 'caixa-photo.js', 'text/javascript; charset=utf-8');
  text('/operacao/caixa-notifications.js', 'caixa-notifications.js', 'text/javascript; charset=utf-8');
  text('/operacao/caixa.js', 'caixa.js', 'text/javascript; charset=utf-8');
  fastify.get('/operacao/som-pedido-novo.mp3', { preHandler: flagGate }, async (_request, reply) => {
    const content = await readFile(path.join(partnerAssetsDir, 'som-pedido-novo.mp3'));
    return reply.header('Content-Type', 'audio/mpeg')
      .header('Cache-Control', 'public, max-age=31536000, immutable').send(content);
  });
  text(
    '/operacao/logo-2w.svg',
    'assets/2w-app-icon-1024.svg',
    'image/svg+xml',
    'public, max-age=31536000, immutable',
  );
  text(
    '/operacao/hero-atendente-v1.webp',
    'assets/caixa-login-atendente-v1.webp',
    'image/webp',
    'public, max-age=31536000, immutable',
  );
  text(
    '/operacao/catalog-tire.webp',
    'assets/catalog-tire.webp',
    'image/webp',
    'public, max-age=31536000, immutable',
  );
  text(
    '/operacao/vendas-hero.webp',
    'assets/vendas-hero.webp',
    'image/webp',
    'public, max-age=31536000, immutable',
  );
  text('/operacao/maps-logo.png', 'assets/navigation-google-maps-official-v1.png', 'image/png', 'public, max-age=31536000, immutable');
  text('/operacao/waze-logo.png', 'assets/navigation-waze-official-v1.png', 'image/png', 'public, max-age=31536000, immutable');
  text('/operacao/finance-hero.webp', 'assets/finance-simple-hero-v1.webp', 'image/webp', 'public, max-age=31536000, immutable');
  text('/operacao/finance-shell-positive-v2.webp', 'assets/finance-shell-positive-v2.webp', 'image/webp', 'public, max-age=31536000, immutable');
  text('/operacao/finance-shell-negative-v2.webp', 'assets/finance-shell-negative-v2.webp', 'image/webp', 'public, max-age=31536000, immutable');
  text('/operacao/finance-shell-positive-v3.webp', 'assets/finance-shell-positive-v3.webp', 'image/webp', 'public, max-age=31536000, immutable');
  text('/operacao/finance-shell-negative-v3.webp', 'assets/finance-shell-negative-v3.webp', 'image/webp', 'public, max-age=31536000, immutable');
}

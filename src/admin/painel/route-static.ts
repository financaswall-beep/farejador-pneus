// Obra 300 (2026-07-05): fatia da PORTARIA da matriz — estáticos do painel (index/app.js/módulos/css).
// VERBATIM das linhas 377-394 do route.ts pré-obra (corpo de registerPainelRoute).
// Registrada por ./route.js (porta de entrada) na ordem original.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminAuth } from '../auth.js';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';
import { sendStatic } from './route-helpers.js';

export async function registerPainelStatic(fastify: FastifyInstance): Promise<void> {
  fastify.get('/admin/login', async (_request, reply) =>
    sendStatic(reply.header('Cache-Control', 'no-store'), 'login.html', 'text/html; charset=utf-8'));
  fastify.get('/admin/login.js', async (_request, reply) =>
    sendStatic(reply.header('Cache-Control', 'no-store'), 'login.js', 'text/javascript; charset=utf-8'));
  fastify.get('/admin/login.css', async (_request, reply) =>
    sendStatic(reply.header('Cache-Control', 'no-store'), 'login.css', 'text/css; charset=utf-8'));
  fastify.get('/admin/painel', async (_request, reply) =>
    sendStatic(reply.header('Cache-Control', 'no-store'), 'index.html', 'text/html; charset=utf-8'));
  fastify.get('/admin/painel/', async (_request, reply) =>
    sendStatic(reply.header('Cache-Control', 'no-store'), 'index.html', 'text/html; charset=utf-8'));
  fastify.get('/admin/painel/app.js', async (_request, reply) => sendStatic(reply, 'app.js', 'text/javascript; charset=utf-8'));
  // Obra 300 (2026-07-05): módulos-fábrica do painel — lista FIXA (sem wildcard; nada de path traversal).
  const painelModulos = [
    'app.nav.js', 'app.rede.kpis.js', 'app.rede.mock.js', 'app.unidade.kpis.js', 'app.venda.modal.js', 'app.api.js',
    'app.format.js', 'app.varejo.js', 'app.vendas.historico.js', 'app.comissoes.js', 'app.atacado.js', 'app.compras.js', 'app.compras.relatorios.js', 'app.compras.acoes.js',
    'app.logistica.js', 'app.logistica.resultado.js', 'app.logistica.comprovantes.js',
    'app.logistica.acoes.js', 'app.colaboradores.js', 'app.colaboradores.gestao.js', 'app.sino.js', 'app.financeiro.js',
    'app.financeiro.indicadores.js', 'app.financeiro.despesas.js', // fatia 07-14 do financeiro (fiscal 300)
    'app.galpao.js', 'app.rede.apply.js', 'app.pedidos.parceiros.js', 'app.core.js',
    'app.charts.rede.js', 'app.charts.saude.js', 'app.charts.unidade.js',
    'mapa-rm-dados.js', 'app.bot.js', 'app.bot.mapa.js', 'app.clientes.js', 'app.clientes.identity.js',
    'app.montagem.js', // fatia 07-14: compositor + lista de fábricas (app.js ficou só o estado)
  ];
  for (const modulo of painelModulos) {
    fastify.get(`/admin/painel/${modulo}`, async (_request, reply) => sendStatic(reply, modulo, 'text/javascript; charset=utf-8'));
  }
  fastify.get('/admin/painel/rede-fallback.js', async (_request, reply) => sendStatic(reply, 'rede-fallback.js', 'text/javascript; charset=utf-8'));
  for (const vendor of [
    'alpine-3.14.9.min.js',
    'chart-4.4.7.umd.min.js',
    'lucide-1.17.0.min.js',
  ]) {
    fastify.get(`/admin/painel/vendor/${vendor}`, async (_request, reply) =>
      sendStatic(
        reply.header('Cache-Control', 'public, max-age=31536000, immutable'),
        `vendor/${vendor}`,
        'text/javascript; charset=utf-8',
      ));
  }
  fastify.get('/admin/painel/style.css', async (_request, reply) => sendStatic(reply, 'style.css', 'text/css; charset=utf-8'));
  fastify.get('/admin/painel/tailwind.css', async (_request, reply) =>
    sendStatic(reply.header('Cache-Control', 'public, max-age=86400'), 'tailwind.css', 'text/css; charset=utf-8'));
  fastify.get('/admin/painel/assets/logistica-hero.webp', async (_request, reply) =>
    sendStatic(reply.header('Cache-Control', 'public, max-age=86400'), 'assets/logistica-hero.webp', 'image/webp'));
  fastify.get('/admin/painel/assets/bot-hero.webp', async (_request, reply) =>
    sendStatic(reply.header('Cache-Control', 'public, max-age=86400'), 'assets/bot-hero.webp', 'image/webp'));
  fastify.get('/admin/painel/assets/compras-hero.webp', async (_request, reply) =>
    sendStatic(reply.header('Cache-Control', 'public, max-age=86400'), 'assets/compras-hero.webp', 'image/webp'));
  fastify.get('/admin/painel/assets/vendas-hero.webp', async (_request, reply) =>
    sendStatic(reply.header('Cache-Control', 'public, max-age=86400'), 'assets/vendas-hero.webp', 'image/webp'));
  fastify.get('/admin/painel/assets/rede-hero-v2.webp', async (_request, reply) =>
    sendStatic(reply.header('Cache-Control', 'public, max-age=31536000, immutable'), 'assets/rede-hero-v2.webp', 'image/webp'));
  fastify.get('/admin/painel/assets/rede-hero-visao-v3.webp', async (_request, reply) =>
    sendStatic(reply.header('Cache-Control', 'public, max-age=31536000, immutable'), 'assets/rede-hero-visao-v3.webp', 'image/webp'));
  for (const brand of ['facebook.svg', 'google-ads.svg', 'instagram.svg', 'whatsapp.svg']) {
    fastify.get(`/assets/brands/${brand}`, async (_request, reply) =>
      sendStatic(reply.header('Cache-Control', 'public, max-age=86400'), `assets/brands/${brand}`, 'image/svg+xml'));
  }
  fastify.get('/seja-parceiro-2w.png', async (_request, reply) => sendStatic(reply, 'seja-parceiro-2w.png', 'image/png'));

}

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
  fastify.get('/admin/painel', async (_request, reply) => sendStatic(reply, 'index.html', 'text/html; charset=utf-8'));
  fastify.get('/admin/painel/', async (_request, reply) => sendStatic(reply, 'index.html', 'text/html; charset=utf-8'));
  fastify.get('/admin/painel/app.js', async (_request, reply) => sendStatic(reply, 'app.js', 'text/javascript; charset=utf-8'));
  // Obra 300 (2026-07-05): módulos-fábrica do painel — lista FIXA (sem wildcard; nada de path traversal).
  const painelModulos = [
    'app.nav.js', 'app.rede.kpis.js', 'app.unidade.kpis.js', 'app.venda.modal.js', 'app.api.js',
    'app.format.js', 'app.varejo.js', 'app.comissoes.js', 'app.atacado.js', 'app.compras.js',
    'app.logistica.js', 'app.logistica.acoes.js', 'app.colaboradores.js', 'app.financeiro.js',
    'app.galpao.js', 'app.rede.apply.js', 'app.pedidos.parceiros.js', 'app.core.js',
    'app.charts.rede.js', 'app.charts.saude.js', 'app.charts.unidade.js',
  ];
  for (const modulo of painelModulos) {
    fastify.get(`/admin/painel/${modulo}`, async (_request, reply) => sendStatic(reply, modulo, 'text/javascript; charset=utf-8'));
  }
  fastify.get('/admin/painel/rede-fallback.js', async (_request, reply) => sendStatic(reply, 'rede-fallback.js', 'text/javascript; charset=utf-8'));
  fastify.get('/admin/painel/style.css', async (_request, reply) => sendStatic(reply, 'style.css', 'text/css; charset=utf-8'));
  fastify.get('/seja-parceiro-2w.png', async (_request, reply) => sendStatic(reply, 'seja-parceiro-2w.png', 'image/png'));

}

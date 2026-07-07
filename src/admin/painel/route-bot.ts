// TELA DO BOT (2026-07-06): rotas do agregador do atendente pro painel da matriz.
// Registrada por ./route.js (porta de entrada). Admin-only — conversa de cliente
// é dado sensível: NUNCA servir ao parceiro (zero grant, mesma régua do sino).
import type { FastifyInstance } from 'fastify';
import { requireAdminAuth } from '../auth.js';
import { logger } from '../../shared/logger.js';
import { getBotCampainha, getBotVisao } from './queries.js';
import type { PainelRedePeriod } from './queries-pedidos.js';

const PERIODOS: PainelRedePeriod[] = ['today', '7d', '30d', 'month'];

export async function registerPainelBot(fastify: FastifyInstance): Promise<void> {
  // Campainha: leve (roda no load e no refresh de 15s) — cliente esperando + escalados.
  fastify.get('/admin/api/bot/campainha', { preHandler: requireAdminAuth }, async (_request, reply) => {
    try {
      return reply.status(200).send(await getBotCampainha());
    } catch (err) {
      logger.error({ err }, 'painel bot campainha failed');
      return reply.status(500).send({ error: 'internal_error' });
    }
  });

  // Visão: mapa por município + radar de medidas + cards — carrega ao entrar na aba.
  fastify.get('/admin/api/bot/visao', { preHandler: requireAdminAuth }, async (request, reply) => {
    try {
      const q = (request.query ?? {}) as { period?: string };
      const period: PainelRedePeriod = PERIODOS.includes(q.period as PainelRedePeriod)
        ? (q.period as PainelRedePeriod)
        : '30d';
      return reply.status(200).send(await getBotVisao(period));
    } catch (err) {
      logger.error({ err }, 'painel bot visao failed');
      return reply.status(500).send({ error: 'internal_error' });
    }
  });
}

// TELA DO BOT (2026-07-06): rotas do agregador do atendente pro painel da matriz.
// Registrada por ./route.js (porta de entrada). Admin-only — conversa de cliente
// é dado sensível: NUNCA servir ao parceiro (zero grant, mesma régua do sino).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminAuth, requireAdminOwner } from '../auth.js';
import { logger } from '../../shared/logger.js';
import { getBotCampainha, getBotResilience, getBotVisao,
  reprocessBotDeadLetter, resolveBotDeadLetter } from './queries.js';
import { operatorLabel } from './route-helpers.js';
import type { PainelRedePeriod } from './queries-pedidos.js';

const PERIODOS: PainelRedePeriod[] = ['today', '7d', '30d', 'month'];
const deadLetterActionSchema = z.object({ id: z.string().uuid(), reason: z.string().trim().min(5).max(500),
  risk_confirmed: z.boolean().optional() }).strict();

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

  fastify.get('/admin/api/bot/resiliencia', { preHandler: requireAdminAuth }, async (_request, reply) => {
    try { return reply.status(200).send(await getBotResilience()); }
    catch (err) {
      logger.error({ err }, 'painel bot resiliencia failed');
      return reply.status(500).send({ error: 'internal_error' });
    }
  });

  fastify.post('/admin/api/bot/resiliencia/reprocessar', { preHandler: requireAdminOwner }, async (request, reply) => {
    const parsed = deadLetterActionSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body' });
    try {
      return reply.status(200).send(await reprocessBotDeadLetter({ ...parsed.data,
        risk_confirmed: parsed.data.risk_confirmed === true, actor: operatorLabel(request) }));
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      if (message === 'bot_dead_letter_not_found') return reply.status(404).send({ error: message });
      if (message.includes('required')) return reply.status(400).send({ error: message });
      logger.error({ err }, 'painel bot dead letter reprocess failed');
      return reply.status(500).send({ error: 'internal_error' });
    }
  });

  fastify.post('/admin/api/bot/resiliencia/resolver', { preHandler: requireAdminOwner }, async (request, reply) => {
    const parsed = deadLetterActionSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body' });
    try {
      return reply.status(200).send(await resolveBotDeadLetter({ id: parsed.data.id,
        reason: parsed.data.reason, actor: operatorLabel(request) }));
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      if (message === 'bot_dead_letter_not_found') return reply.status(404).send({ error: message });
      if (message.includes('required')) return reply.status(400).send({ error: message });
      logger.error({ err }, 'painel bot dead letter resolve failed');
      return reply.status(500).send({ error: 'internal_error' });
    }
  });
}

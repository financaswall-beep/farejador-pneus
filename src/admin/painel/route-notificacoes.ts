// SINO da matriz (2026-07-06): rota do agregador de notificações reais.
// Registrada por ./route.js (porta de entrada). Admin-only — o sino é do dono.
import type { FastifyInstance } from 'fastify';
import { getAdminContext, requireAdminAuth } from '../auth.js';
import type { MatrixPanelModule } from '../panel-modules.js';
import { logger } from '../../shared/logger.js';
import { getMatrizNotificacoes } from './queries.js';

export async function registerPainelNotificacoes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/admin/api/matriz/notificacoes', { preHandler: requireAdminAuth }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const context = getAdminContext(request);
      const can = (module: MatrixPanelModule) => context.role === 'owner' || context.modules.includes(module);
      const data = await getMatrizNotificacoes();
      // Lista explícita: acrescentar um campo à consulta não pode expor outro módulo.
      return reply.status(200).send({
        ...(can('logistica') ? { entregas_falhadas: data.entregas_falhadas } : {}),
        ...(can('financeiro') ? { fiado_vencido: data.fiado_vencido,
          a_pagar_vencido: data.a_pagar_vencido, ledger_health: data.ledger_health } : {}),
        ...(can('estoque') ? { galpao_repor: data.galpao_repor } : {}),
        ...(can('retiradas') ? { bot_reservations_expiring: data.bot_reservations_expiring } : {}),
        ...(can('bot') ? { bot_resilience: data.bot_resilience,
          bot_reservation_expiry_failures: data.bot_reservation_expiry_failures,
          normalization_failed: data.normalization_failed } : {}),
      });
    } catch (err) {
      logger.error({ err }, 'painel notificacoes failed');
      return reply.status(500).send({ error: 'internal_error' });
    }
  });
}

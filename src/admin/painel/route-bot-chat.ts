import type { FastifyInstance } from 'fastify';
import { getAdminContext, requireAdminAuth, requireAdminOwner } from '../auth.js';
import { env } from '../../shared/config/env.js';
import { registerOperatorChatRoutes } from '../caixa/route-chat.js';

/** O painel usa sua própria sessão e permissão Bot; o envio é o mesmo da Operação. */
export function registerBotChatRoutes(app: FastifyInstance): void {
  registerOperatorChatRoutes(app, {
    prefix: '/admin/api/bot/chat',
    historyGuards: [requireAdminOwner],
    guards: [requireAdminAuth, async (request, reply) => {
      const context = getAdminContext(request);
      if (env.MATRIZ_CUSTOMER_IDENTITY && context.role !== 'owner') {
        await reply.code(403).send({ error: 'forbidden' });
      }
    }],
    actor: request => `admin:${getAdminContext(request).personId ?? 'emergency'}`,
    principal: request => `admin:${getAdminContext(request).personId ?? 'emergency'}`,
    canReadMilly: request => {
      const context = getAdminContext(request);
      return context.authType === 'session' && context.role === 'owner' && !!context.personId;
    },
  });
}

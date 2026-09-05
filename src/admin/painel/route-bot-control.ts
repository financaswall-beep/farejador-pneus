import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminAuth } from '../auth.js';
import { logger } from '../../shared/logger.js';
import { operatorLabel } from './route-helpers.js';
import { changeBotConversationControl, getBotConversationControl, listHumanControlledConversations } from './bot-conversation-control.js';

const paramsSchema = z.object({ id:z.string().uuid() });
const bodySchema = z.object({ action:z.enum(['takeover','resume']),expected_version:z.number().int().min(0) }).strict();
function statusFor(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (message==='bot_conversation_not_found') return { status:404,error:message };
  if (message==='bot_control_conflict') return { status:409,error:message };
  logger.error({ err:error },'bot conversation control failed');
  return { status:500,error:'internal_error' };
}

export async function registerBotControlRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/api/bot/controle', { preHandler:requireAdminAuth },async (_request,reply) => {
    try { return { conversations:await listHumanControlledConversations() }; }
    catch (error) { const mapped=statusFor(error); return reply.code(mapped.status).send({ error:mapped.error }); }
  });
  app.get('/admin/api/bot/conversations/:id/controle',{ preHandler:requireAdminAuth },async (request,reply) => {
    const parsed=paramsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error:'invalid_conversation' });
    try { return await getBotConversationControl(parsed.data.id); }
    catch (error) { const mapped=statusFor(error); return reply.code(mapped.status).send({ error:mapped.error }); }
  });
  app.post('/admin/api/bot/conversations/:id/controle',{ preHandler:requireAdminAuth },async (request,reply) => {
    const params=paramsSchema.safeParse(request.params),body=bodySchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error:'invalid_body' });
    try { return await changeBotConversationControl({ conversationId:params.data.id,
      action:body.data.action,expectedVersion:body.data.expected_version,actor:operatorLabel(request) }); }
    catch (error) { const mapped=statusFor(error); return reply.code(mapped.status).send({ error:mapped.error }); }
  });
}

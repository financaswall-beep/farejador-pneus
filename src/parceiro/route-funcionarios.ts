import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPartnerContext, requireOwner, requirePartnerAuth, type PartnerAuthedRequest } from './auth.js';
import { PartnerUsernameConflictError, reactivatePartnerFuncionario } from './queries.js';

const paramsSchema = z.object({ slug: z.string(), tokenId: z.string().uuid() });

/** Fecha o ciclo de vida do funcionário sem apagar vendas, comissões ou auditoria. */
export function registerPartnerFuncionarioReactivationRoute(fastify: FastifyInstance): void {
  fastify.post('/parceiro/:slug/api/funcionarios/:tokenId/reativar', {
    preHandler: [requirePartnerAuth, requireOwner],
  }, async (request: PartnerAuthedRequest, reply) => {
    const parsed = paramsSchema.safeParse(request.params);
    if (!parsed.success) return reply.status(404).send({ error: 'funcionario_not_found' });
    try {
      const result = await reactivatePartnerFuncionario(getPartnerContext(request), parsed.data.tokenId);
      if (!result.reactivated) return reply.status(404).send({ error: 'funcionario_not_found' });
      return reply.status(200).send(result);
    } catch (err) {
      if (err instanceof PartnerUsernameConflictError) return reply.status(409).send({ error: 'username_taken' });
      throw err;
    }
  });
}

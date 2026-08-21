import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { setPartnerUnitCoverage } from '../admin/painel/queries-parceiros-rede.js';
import { networkMunicipalitiesSchema } from '../network/municipality-schema.js';
import {
  getPartnerContext,
  requireOwner,
  requirePartnerAuth,
  type PartnerAuthedRequest,
} from './auth.js';

const configCoverageSchema = z.object({
  municipios: networkMunicipalitiesSchema,
});

export function registerPartnerCoverageRoute(fastify: FastifyInstance): void {
  fastify.put(
    '/parceiro/:slug/api/configuracoes/cobertura',
    { preHandler: [requirePartnerAuth, requireOwner] },
    async (request: PartnerAuthedRequest, reply) => {
      const parsed = configCoverageSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
      }
      const ctx = getPartnerContext(request);
      const result = await setPartnerUnitCoverage(
        ctx.environment,
        ctx.partnerUnitId,
        parsed.data.municipios,
        `partner-owner:${ctx.tokenId}`,
      );
      if (!result.updated) return reply.status(404).send({ error: 'partner_not_found' });
      return reply.status(200).send(result);
    },
  );
}

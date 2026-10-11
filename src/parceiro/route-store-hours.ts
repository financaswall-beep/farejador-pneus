import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { weeklyStoreHoursSchema } from '../shared/weekly-store-hours.js';
import { getPartnerContext, requireOwner, requirePartnerAuth, type PartnerAuthedRequest } from './auth.js';
import { getPartnerStoreHours, savePartnerStoreHours } from './store-hours.js';
import { getPartnerConfiguracoes } from './queries.js';

const bodySchema = z.object({ hours: weeklyStoreHoursSchema }).strict();
export function registerPartnerStoreHoursRoutes(fastify: FastifyInstance): void {
  const path = '/parceiro/:slug/api/configuracoes/horarios';
  const preHandler = [requirePartnerAuth, requireOwner];
  // A leitura geral usada por Minha loja acompanha o editor, sem mudar o contrato.
  fastify.get('/parceiro/:slug/api/configuracoes', { preHandler }, async (request: PartnerAuthedRequest, reply) => {
    return reply.status(200).send(await getPartnerConfiguracoes(getPartnerContext(request)));
  });
  fastify.get(path, { preHandler }, async (request: PartnerAuthedRequest, reply) => {
    reply.header('Cache-Control', 'no-store');
    const result = await getPartnerStoreHours(getPartnerContext(request));
    return result ? result : reply.status(404).send({ error: 'unit_not_found' });
  });
  fastify.put(path, { preHandler }, async (request: PartnerAuthedRequest, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_store_hours',
      message: parsed.error.issues[0]?.message ?? 'Confira os horários.' });
    try {
      const result = await savePartnerStoreHours(getPartnerContext(request), parsed.data.hours);
      return result ? result : reply.status(404).send({ error: 'unit_not_found' });
    } catch (error) {
      if ((error as { code?: string }).code === '42703') return reply.status(503).send({ error: 'store_hours_schema_missing',
        message: 'A atualização dos horários ainda não está disponível.' });
      throw error;
    }
  });
}

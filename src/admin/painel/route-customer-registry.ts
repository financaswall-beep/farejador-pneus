import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminOwner, getAdminContext } from '../auth.js';
import { env } from '../../shared/config/env.js';
import { createRegistrySchema, updateRegistrySchema } from './customer-registry-schema.js';
import { createCustomerRegistry, updateCustomerRegistry } from './customer-registry.js';

const paramsSchema = z.object({source:z.enum(['chatwoot','balcao','parceiro','atacado']),id:z.string().uuid()});
export async function registerCustomerRegistryRoutes(app: FastifyInstance) {
  app.post('/admin/api/clientes/cadastro',{preHandler:requireAdminOwner},async (request,reply) => {
    reply.header('Cache-Control','private, no-store');
    if (!env.MATRIZ_CUSTOMER_REGISTRY) return reply.code(404).send({error:'registry_disabled'});
    const parsed = createRegistrySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({error:'invalid_customer',fields:parsed.error.flatten().fieldErrors});
    const {idempotency_key,...input} = parsed.data;
    try { return await createCustomerRegistry(env.FAREJADOR_ENV,input,idempotency_key,getAdminContext(request).displayName); }
    catch(error) { return registryError(reply,error); }
  });
  app.put('/admin/api/clientes/:source/:id/cadastro',{preHandler:requireAdminOwner},async (request,reply) => {
    reply.header('Cache-Control','private, no-store');
    if (!env.MATRIZ_CUSTOMER_REGISTRY) return reply.code(404).send({error:'registry_disabled'});
    const params = paramsSchema.safeParse(request.params), body = updateRegistrySchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({error:'invalid_request'});
    if (!body.success) return reply.code(400).send({error:'invalid_customer',fields:body.error.flatten().fieldErrors});
    const {expected_version,...input} = body.data;
    try {
      const row = await updateCustomerRegistry(env.FAREJADOR_ENV,params.data.source,params.data.id,input,
        expected_version,getAdminContext(request).displayName);
      return {source:row.source,source_id:row.source_id,version:row.version};
    } catch(error) { return registryError(reply,error); }
  });
}
function registryError(reply: import('fastify').FastifyReply,error: unknown) {
  const code = error instanceof Error ? error.message : '';
  if (code === 'customer_not_found') return reply.code(404).send({error:code});
  if (['registry_version_conflict','idempotency_conflict','customer_phone_exists'].includes(code)) return reply.code(409).send({error:code});
  return reply.code(503).send({error:'customer_registry_unavailable'});
}

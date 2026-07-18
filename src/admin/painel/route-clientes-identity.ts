import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getAdminContext, requireAdminOwner } from '../auth.js';
import { env } from '../../shared/config/env.js';
import { rateLimitHit, rateLimitRetryAfterSeconds } from '../../shared/rate-limit.js';
import { auditCustomerExport, streamCustomerCsv } from './customer-export.js';
import { backfillCustomerIdentities, decideIdentityCandidate, listIdentityCandidates } from './customer-identity-service.js';
import { splitCustomerIdentity } from './customer-identity-split.js';
import { getClientePainelV2ById, getClientesPainelV2 } from './queries-clientes-v2.js';

const idParam = z.object({ id:z.string().uuid() });
const pageQuery = z.object({ cursor:z.string().max(200).optional(),limit:z.coerce.number().int().min(1).max(200).optional(),
  filter:z.string().trim().max(120).optional() });
const exportQuery = z.object({ filter:z.string().trim().max(120).optional(),reason:z.string().trim().min(5).max(240) });
const reasonBody = z.object({ reason:z.string().trim().min(5).max(500) });
const splitBody = z.object({ reason:z.string().trim().min(5).max(500),link_ids:z.array(z.string().uuid()).min(1).max(100),
  idempotency_key:z.string().trim().min(8).max(160),confirmation:z.literal('SEPARAR IDENTIDADE') });
const backfillBody = z.object({ reason:z.string().trim().min(5).max(500),confirmation:z.literal('CRIAR IDENTIDADES') });

function gate(reply: FastifyReply): boolean {
  if (env.MATRIZ_CUSTOMER_IDENTITY) return true;
  void reply.status(404).send({ error:'not_found' }); return false;
}

function limitSensitive(request: FastifyRequest,reply: FastifyReply,action: string,max=20): boolean {
  const context = getAdminContext(request);
  const key = `customer-identity:${action}:${context.personId ?? request.ip}`;
  if (!rateLimitHit(key,max,60_000)) return true;
  void reply.header('Retry-After',String(rateLimitRetryAfterSeconds(key))).status(429).send({ error:'too_many_attempts' });
  return false;
}

function sendError(reply: FastifyReply,error: unknown) {
  const code = error instanceof Error ? error.message : 'internal_server_error';
  if (['identity_not_found','candidate_not_found'].includes(code)) return reply.status(404).send({ error:code });
  if (['candidate_already_decided','candidate_identity_inactive','split_must_leave_source','idempotency_conflict'].includes(code)) {
    return reply.status(409).send({ error:code });
  }
  if (['reason_required','idempotency_key_required','link_ids_required','split_link_not_found','invalid_cursor'].includes(code)) {
    return reply.status(400).send({ error:code });
  }
  return reply.status(500).send({ error:'internal_server_error' });
}

export async function registerCustomerIdentityRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/admin/api/clientes-v2',{ preHandler:requireAdminOwner },async (request,reply) => {
    if (!gate(reply)) return;
    const parsed = pageQuery.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error:'invalid_query' });
    try { return reply.status(200).send(await getClientesPainelV2(parsed.data)); }
    catch (error) { return sendError(reply,error); }
  });

  fastify.get('/admin/api/clientes-v2/candidates',{ preHandler:requireAdminOwner },async (request,reply) => {
    if (!gate(reply)) return;
    const parsed = z.object({ status:z.enum(['pending','approved','rejected','expired']).optional() }).safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error:'invalid_query' });
    return reply.status(200).send({ candidates:await listIdentityCandidates(env.FAREJADOR_ENV,parsed.data.status ?? 'pending') });
  });

  fastify.get('/admin/api/clientes-v2/export',{ preHandler:requireAdminOwner },async (request,reply) => {
    if (!gate(reply) || !limitSensitive(request,reply,'export',5)) return;
    const parsed = exportQuery.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error:'reason_required' });
    try {
      await auditCustomerExport(env.FAREJADOR_ENV,`${getAdminContext(request).displayName}`,
        parsed.data.reason,Boolean(parsed.data.filter));
      return reply.header('Content-Type','text/csv; charset=utf-8')
        .header('Content-Disposition','attachment; filename="clientes.csv"')
        .send(Readable.from(streamCustomerCsv(env.FAREJADOR_ENV,parsed.data.filter)));
    } catch (error) { return sendError(reply,error); }
  });

  fastify.post('/admin/api/clientes-v2/backfill',{ preHandler:requireAdminOwner },async (request,reply) => {
    if (!gate(reply) || !limitSensitive(request,reply,'backfill',2)) return;
    const parsed = backfillBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error:'explicit_confirmation_required' });
    try {
      const actor = getAdminContext(request).displayName;
      return reply.status(200).send(await backfillCustomerIdentities(env.FAREJADOR_ENV,actor));
    } catch (error) { return sendError(reply,error); }
  });

  fastify.post('/admin/api/clientes-v2/candidates/:id/approve',{ preHandler:requireAdminOwner },async (request,reply) => {
    if (!gate(reply) || !limitSensitive(request,reply,'approve')) return;
    const params = idParam.safeParse(request.params);
    const body = reasonBody.extend({ confirmation:z.literal('UNIR IDENTIDADES') }).safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ error:'invalid_request' });
    try { return reply.status(200).send(await decideIdentityCandidate({ environment:env.FAREJADOR_ENV,
      candidateId:params.data.id,decision:'approve',actor:getAdminContext(request).displayName,reason:body.data.reason })); }
    catch (error) { return sendError(reply,error); }
  });

  fastify.post('/admin/api/clientes-v2/candidates/:id/reject',{ preHandler:requireAdminOwner },async (request,reply) => {
    if (!gate(reply) || !limitSensitive(request,reply,'reject')) return;
    const params = idParam.safeParse(request.params); const body = reasonBody.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ error:'invalid_request' });
    try { return reply.status(200).send(await decideIdentityCandidate({ environment:env.FAREJADOR_ENV,
      candidateId:params.data.id,decision:'reject',actor:getAdminContext(request).displayName,reason:body.data.reason })); }
    catch (error) { return sendError(reply,error); }
  });

  fastify.post('/admin/api/clientes-v2/:id/split',{ preHandler:requireAdminOwner },async (request,reply) => {
    if (!gate(reply) || !limitSensitive(request,reply,'split')) return;
    const params = idParam.safeParse(request.params); const body = splitBody.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ error:'invalid_request' });
    try { return reply.status(200).send(await splitCustomerIdentity({ environment:env.FAREJADOR_ENV,
      identityId:params.data.id,linkIds:body.data.link_ids,actor:getAdminContext(request).displayName,
      reason:body.data.reason,idempotencyKey:body.data.idempotency_key })); }
    catch (error) { return sendError(reply,error); }
  });

  fastify.get('/admin/api/clientes-v2/:id',{ preHandler:requireAdminOwner },async (request,reply) => {
    if (!gate(reply)) return;
    const parsed = idParam.safeParse(request.params);
    if (!parsed.success) return reply.status(400).send({ error:'invalid_id' });
    const row = await getClientePainelV2ById(parsed.data.id);
    return row ? reply.status(200).send(row) : reply.status(404).send({ error:'identity_not_found' });
  });
}

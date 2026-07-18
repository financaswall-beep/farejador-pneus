import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getAdminContext, requireAdminOwner } from '../auth.js';
import { env } from '../../shared/config/env.js';
import { rateLimitHit, rateLimitRetryAfterSeconds } from '../../shared/rate-limit.js';
import {
  approvePrivacyRequest, createPrivacyRequest, executePrivacyRequest, getPrivacyRequest,
  previewPrivacyRequest, verifyPrivacyRequest,
} from './customer-privacy-service.js';

const idParam = z.object({ id:z.string().uuid() });
const createBody = z.object({ identity_id:z.string().uuid(),request_type:z.enum(['portability','anonymization']),
  idempotency_key:z.string().trim().min(8).max(160) });
const verifyBody = z.object({ registered_channel_confirmed:z.boolean(),transaction_evidence_confirmed:z.boolean() });
const approveBody = z.object({ reason:z.string().trim().min(5).max(500),confirmation:z.literal('APROVAR SOLICITACAO') });
const executeBody = z.object({ confirmation:z.string().max(80) });

function gate(reply: FastifyReply): boolean {
  if (env.MATRIZ_CUSTOMER_IDENTITY && env.MATRIZ_CUSTOMER_PRIVACY) return true;
  void reply.status(404).send({ error:'not_found' }); return false;
}

function limited(request: FastifyRequest,reply: FastifyReply): boolean {
  const key = `customer-privacy:${getAdminContext(request).personId ?? request.ip}`;
  if (!rateLimitHit(key,30,60_000)) return false;
  void reply.header('Retry-After',String(rateLimitRetryAfterSeconds(key))).status(429).send({ error:'too_many_attempts' });
  return true;
}

function privacyError(reply: FastifyReply,error: unknown) {
  const code = error instanceof Error ? error.message : 'internal_server_error';
  if (['privacy_request_not_found','identity_not_found'].includes(code)) return reply.status(404).send({ error:code });
  if (['privacy_request_invalid_state','privacy_request_processing','idempotency_conflict'].includes(code)) {
    return reply.status(409).send({ error:code });
  }
  if (['idempotency_key_required','reason_required','explicit_confirmation_required'].includes(code)) {
    return reply.status(400).send({ error:code });
  }
  if (code === 'anonymization_execution_disabled') {
    return reply.status(403).send({ error:code,destructive_changes:false });
  }
  return reply.status(500).send({ error:'internal_server_error' });
}

export async function registerCustomerPrivacyRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/admin/api/privacy/requests',{ preHandler:requireAdminOwner },async (request,reply) => {
    if (!gate(reply) || limited(request,reply)) return;
    const parsed = createBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error:'invalid_body' });
    try { return reply.status(201).send(await createPrivacyRequest({ environment:env.FAREJADOR_ENV,
      identityId:parsed.data.identity_id,requestType:parsed.data.request_type,
      idempotencyKey:parsed.data.idempotency_key,actor:getAdminContext(request).displayName })); }
    catch (error) { return privacyError(reply,error); }
  });

  fastify.get('/admin/api/privacy/requests/:id',{ preHandler:requireAdminOwner },async (request,reply) => {
    if (!gate(reply) || limited(request,reply)) return;
    const parsed = idParam.safeParse(request.params);
    if (!parsed.success) return reply.status(400).send({ error:'invalid_id' });
    const found = await getPrivacyRequest(env.FAREJADOR_ENV,parsed.data.id);
    return found ? reply.status(200).send(found) : reply.status(404).send({ error:'privacy_request_not_found' });
  });

  fastify.post('/admin/api/privacy/requests/:id/verify',{ preHandler:requireAdminOwner },async (request,reply) => {
    if (!gate(reply) || limited(request,reply)) return;
    const params = idParam.safeParse(request.params); const body = verifyBody.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ error:'invalid_request' });
    try { return reply.status(200).send(await verifyPrivacyRequest({ environment:env.FAREJADOR_ENV,
      requestId:params.data.id,actor:getAdminContext(request).displayName,
      registeredChannelConfirmed:body.data.registered_channel_confirmed,
      transactionEvidenceConfirmed:body.data.transaction_evidence_confirmed })); }
    catch (error) { return privacyError(reply,error); }
  });

  fastify.post('/admin/api/privacy/requests/:id/preview',{ preHandler:requireAdminOwner },async (request,reply) => {
    if (!gate(reply) || limited(request,reply)) return;
    const params = idParam.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error:'invalid_id' });
    try { return reply.status(200).send(await previewPrivacyRequest(env.FAREJADOR_ENV,params.data.id,
      getAdminContext(request).displayName)); }
    catch (error) { return privacyError(reply,error); }
  });

  fastify.post('/admin/api/privacy/requests/:id/approve',{ preHandler:requireAdminOwner },async (request,reply) => {
    if (!gate(reply) || limited(request,reply)) return;
    const params = idParam.safeParse(request.params); const body = approveBody.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ error:'invalid_request' });
    try { return reply.status(200).send(await approvePrivacyRequest(env.FAREJADOR_ENV,params.data.id,
      getAdminContext(request).displayName,body.data.reason)); }
    catch (error) { return privacyError(reply,error); }
  });

  fastify.post('/admin/api/privacy/requests/:id/execute',{ preHandler:requireAdminOwner },async (request,reply) => {
    if (!gate(reply) || limited(request,reply)) return;
    const params = idParam.safeParse(request.params); const body = executeBody.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ error:'invalid_request' });
    try { return reply.status(200).send(await executePrivacyRequest(env.FAREJADOR_ENV,params.data.id,
      getAdminContext(request).displayName,body.data.confirmation)); }
    catch (error) { return privacyError(reply,error); }
  });
}

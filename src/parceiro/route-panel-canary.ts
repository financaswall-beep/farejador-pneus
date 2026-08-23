import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getPartnerContext, requirePartnerAuth, resolvePartnerPermissions,
  type PartnerAuthedRequest,
} from './auth.js';
import { recordPartnerPanelCanaryEvent } from './panel-canary.js';

const operationSchema = z.enum([
  'load_summary', 'load_pickups', 'confirm_pickup', 'cancel_pickup',
]);

const canaryEventSchema = z.object({
  page: z.enum(['resumo', 'retiradas']),
  event_type: z.enum(['page_open', 'read', 'write']),
  operation: operationSchema.nullable().optional(),
  outcome: z.enum(['success', 'error']),
  status_code: z.number().int().min(100).max(599).nullable().optional(),
  duration_ms: z.number().int().min(0).max(600_000).nullable().optional(),
  error_code: z.string().min(1).max(80).regex(/^[a-zA-Z0-9_.:-]+$/).nullable().optional(),
}).strict().superRefine((event, ctx) => {
  const operation = event.operation ?? null;
  if (event.event_type === 'page_open' && operation !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'page_open_has_no_operation' });
  }
  if (event.event_type !== 'page_open' && operation === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'operation_required' });
  }
  if (event.page === 'resumo' && operation && operation !== 'load_summary') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'operation_page_mismatch' });
  }
  if (event.page === 'retiradas' && operation === 'load_summary') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'operation_page_mismatch' });
  }
  if (event.event_type === 'write' && !['confirm_pickup', 'cancel_pickup'].includes(operation ?? '')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'write_operation_invalid' });
  }
  if (event.outcome === 'success' && event.error_code) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'success_has_no_error' });
  }
});

export function registerPartnerPanelCanaryRoutes(fastify: FastifyInstance): void {
  fastify.post('/parceiro/:slug/api/panel-canary-events', {
    preHandler: requirePartnerAuth,
  }, async (request: PartnerAuthedRequest, reply) => {
    const parsed = canaryEventSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_canary_event' });
    const context = getPartnerContext(request);
    const permissions = await resolvePartnerPermissions(context);
    if (!permissions[parsed.data.page]) {
      return reply.status(403).send({ error: 'partner_forbidden_screen' });
    }
    const recorded = await recordPartnerPanelCanaryEvent(context, {
      page: parsed.data.page,
      eventType: parsed.data.event_type,
      operation: parsed.data.operation ?? null,
      outcome: parsed.data.outcome,
      statusCode: parsed.data.status_code ?? null,
      durationMs: parsed.data.duration_ms ?? null,
      errorCode: parsed.data.error_code ?? null,
    });
    if (!recorded) return reply.status(409).send({ error: 'modern_panel_disabled' });
    return reply.status(202).send({ accepted: true });
  });
}

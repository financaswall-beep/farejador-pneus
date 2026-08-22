import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isNotFutureBusinessDate } from '../shared/business-time.js';
import {
  getPartnerContext, requireOwner, requirePartnerAuth, requireScreen,
  type PartnerAuthedRequest,
} from './auth.js';
import { centMoneySchema } from './purchase-schema.js';
import {
  settlePartnerReceivable,
  settlePartnerReceivableInstallment,
} from './partner-receivable-events.js';
import {
  recoverPartnerReceivable,
  renegotiatePartnerReceivable,
  writeOffPartnerReceivable,
} from './partner-receivable-losses.js';

const ownerOnly = [requirePartnerAuth, requireOwner];
const financeiroScreen = [requirePartnerAuth, requireScreen('financeiro')];
const paramsSchema = z.object({
  slug: z.string().min(2).max(80).regex(/^[a-z0-9-]+$/),
  receivableId: z.string().uuid(),
});
const installmentParamsSchema = paramsSchema.extend({ installmentId: z.string().uuid() });
const factDatetime = (message: string) => z.string().datetime()
  .refine(isNotFutureBusinessDate, message);
const settleSchema = z.object({
  received_at: factDatetime('received_at_future').nullable().optional(),
  payment_method: z.string().max(80).nullable().optional(),
  amount: centMoneySchema.refine((value) => value > 0, 'amount_must_be_positive').nullable().optional(),
  idempotency_key: z.string().min(8).max(200).nullable().optional(),
});
const writeOffSchema = z.object({
  occurred_at: factDatetime('occurred_at_future').nullable().optional(),
  amount: centMoneySchema.refine((value) => value > 0, 'amount_must_be_positive').nullable().optional(),
  reason: z.string().trim().min(3).max(500),
  idempotency_key: z.string().min(8).max(200),
});
const recoverSchema = z.object({
  occurred_at: factDatetime('occurred_at_future').nullable().optional(),
  amount: centMoneySchema.refine((value) => value > 0, 'amount_must_be_positive'),
  payment_method: z.string().trim().min(1).max(80),
  note: z.string().trim().max(500).nullable().optional(),
  idempotency_key: z.string().min(8).max(200),
});
const renegotiateSchema = z.object({
  due_date: z.string().date(),
  reason: z.string().trim().min(3).max(500),
});

function validationError(error: z.ZodError): string {
  const issue = error.issues[0];
  const path = issue?.path?.join('.') || 'body';
  return `${path}: ${issue?.message ?? 'invalid'}`;
}

function isReceiptConflict(error: unknown): boolean {
  return error instanceof Error && [
    'receivable_payment_exceeds_balance',
    'partner_receivable_event_exceeds_balance',
    'partner_finance_idempotency_conflict',
  ].includes(error.message);
}

export function registerPartnerCreditRoutes(fastify: FastifyInstance): void {
  fastify.post('/parceiro/:slug/api/contas-a-receber/:receivableId/receber', {
    preHandler: financeiroScreen,
  }, async (request: PartnerAuthedRequest, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.status(404).send({ error: 'receivable_not_found' });
    const parsed = settleSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: validationError(parsed.error) });
    try {
      const result = await settlePartnerReceivable(
        getPartnerContext(request), params.data.receivableId, parsed.data,
      );
      if (!result.received) return reply.status(404).send({ error: 'receivable_not_found' });
      return reply.status(200).send(result);
    } catch (error) {
      if (isReceiptConflict(error)) return reply.status(409).send({ error: (error as Error).message });
      throw error;
    }
  });

  fastify.post('/parceiro/:slug/api/contas-a-receber/:receivableId/perda', {
    preHandler: ownerOnly,
  }, async (request: PartnerAuthedRequest, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.status(404).send({ error: 'receivable_not_found' });
    const parsed = writeOffSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    try {
      const result = await writeOffPartnerReceivable(
        getPartnerContext(request), params.data.receivableId, parsed.data,
      );
      if (!result.written_off) return reply.status(404).send({ error: 'receivable_not_found' });
      return reply.status(200).send(result);
    } catch (error) {
      if (error instanceof Error && ['receivable_writeoff_exceeds_balance',
        'partner_receivable_event_exceeds_balance',
        'partner_finance_idempotency_conflict'].includes(error.message)) {
        return reply.status(409).send({ error: error.message });
      }
      throw error;
    }
  });

  fastify.post('/parceiro/:slug/api/contas-a-receber/:receivableId/recuperar', {
    preHandler: ownerOnly,
  }, async (request: PartnerAuthedRequest, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.status(404).send({ error: 'receivable_not_found' });
    const parsed = recoverSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    try {
      const result = await recoverPartnerReceivable(
        getPartnerContext(request), params.data.receivableId, parsed.data,
      );
      if (!result.recovered) return reply.status(404).send({ error: 'receivable_not_found' });
      return reply.status(200).send(result);
    } catch (error) {
      if (error instanceof Error && ['partner_receivable_recovery_exceeds_writeoff',
        'partner_finance_idempotency_conflict'].includes(error.message)) {
        return reply.status(409).send({ error: error.message });
      }
      throw error;
    }
  });

  fastify.patch('/parceiro/:slug/api/contas-a-receber/:receivableId/renegociar', {
    preHandler: ownerOnly,
  }, async (request: PartnerAuthedRequest, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.status(404).send({ error: 'receivable_not_found' });
    const parsed = renegotiateSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    const result = await renegotiatePartnerReceivable(
      getPartnerContext(request), params.data.receivableId, parsed.data,
    );
    if (!result.renegotiated) return reply.status(404).send({ error: 'receivable_not_found' });
    return reply.status(200).send(result);
  });

  fastify.post('/parceiro/:slug/api/contas-a-receber/:receivableId/parcelas/:installmentId/receber', {
    preHandler: financeiroScreen,
  }, async (request: PartnerAuthedRequest, reply) => {
    const params = installmentParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(404).send({ error: 'installment_not_found' });
    const parsed = settleSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: validationError(parsed.error) });
    try {
      const result = await settlePartnerReceivableInstallment(
        getPartnerContext(request), params.data.receivableId,
        params.data.installmentId, parsed.data,
      );
      if (!result.received) return reply.status(404).send({ error: 'installment_not_found' });
      return reply.status(200).send(result);
    } catch (error) {
      if (isReceiptConflict(error)) return reply.status(409).send({ error: (error as Error).message });
      throw error;
    }
  });
}

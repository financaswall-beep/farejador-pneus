import type { FastifyInstance } from 'fastify';
import { requireAdminAuth, requireAdminOwner } from '../auth.js';
import { logger } from '../../shared/logger.js';
import { mapWriteError, operatorLabel } from './route-helpers.js';
import {
  listMatrixPartnerCargo, returnPartnerCargoToMatrix, settlePartnerArrival,
} from './queries.js';
import {
  partnerArrivalAdjustmentSchema, partnerCargoParamsSchema,
  partnerCargoReturnSchema, partnerTransferOrderParamsSchema,
} from './route-schemas-partner-transfer.js';

const conflictErrors = new Set([
  'matrix_partner_transfer_not_in_transit',
  'matrix_partner_arrival_items_mismatch',
  'matrix_partner_arrival_quantity_invalid',
  'matrix_partner_arrival_duplicate_item',
  'matrix_partner_arrival_total_mismatch',
  'matrix_partner_cargo_not_found',
  'matrix_partner_cargo_insufficient',
  'matrix_partner_payable_not_open',
  'matrix_partner_original_ledger_missing',
]);

export async function registerPainelPartnerTransfer(fastify: FastifyInstance): Promise<void> {
  fastify.get('/admin/api/wholesale/cargo', {
    preHandler: requireAdminAuth,
  }, async (_request, reply) => reply.status(200).send({
    data: await listMatrixPartnerCargo(),
  }));

  fastify.post('/admin/api/wholesale/sales/:order_id/arrival-adjustment', {
    preHandler: requireAdminOwner,
  }, async (request, reply) => {
    const params = partnerTransferOrderParamsSchema.safeParse(request.params);
    const body = partnerArrivalAdjustmentSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ error: body.success
        ? 'invalid_params' : body.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      return reply.status(200).send(await settlePartnerArrival({
        order_id: params.data.order_id,
        ...body.data,
        actor_label: operatorLabel(request),
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'arrival_adjustment_failed';
      if (conflictErrors.has(message)) return reply.status(409).send({ error: message });
      const mapped = mapWriteError(error);
      logger.error({ err: error, status: mapped.status }, 'partner arrival adjustment failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  fastify.post('/admin/api/wholesale/cargo/:cargo_lot_id/return', {
    preHandler: requireAdminOwner,
  }, async (request, reply) => {
    const params = partnerCargoParamsSchema.safeParse(request.params);
    const body = partnerCargoReturnSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ error: body.success
        ? 'invalid_params' : body.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      return reply.status(200).send(await returnPartnerCargoToMatrix({
        cargo_lot_id: params.data.cargo_lot_id,
        ...body.data,
        actor_label: operatorLabel(request),
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'cargo_return_failed';
      if (conflictErrors.has(message)) return reply.status(409).send({ error: message });
      const mapped = mapWriteError(error);
      logger.error({ err: error, status: mapped.status }, 'partner cargo return failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });
}

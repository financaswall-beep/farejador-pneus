import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../shared/config/env.js';
import {
  PHOTO_MAX_UPLOAD_BYTES,
  PhotoRejectedError,
  reencodePhoto,
} from '../../parceiro/photo-upload.js';
import { extractReceiptSuggestion } from '../painel/receipt-ai-flow.js';
import {
  ReceiptExactDuplicateError,
  TripHasUnresolvedDeliveriesError,
} from '../painel/queries.js';
import {
  addEntregadorReceipt,
  closeEntregadorTrip,
  getEntregadorProductPhotoImage,
  openEntregadorTrip,
  reportEntregadorFail,
  setEntregadorDeliveryStatus,
} from '../entregador/queries.js';
import { caixaCourierAuth, getCaixaDeliveries } from './deliveries.js';
import type { CaixaAuth } from './queries.js';

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
type CaixaRequest = FastifyRequest & { caixa?: CaixaAuth };

const openSchema = z.object({
  km_start: z.coerce.number().min(0).max(9_999_999).optional().nullable(),
  order_ids: z.array(z.string().uuid()).min(1).max(50),
});
const statusSchema = z.object({
  order_id: z.string().uuid(),
  status: z.enum(['pending', 'dispatched', 'delivered']),
  payment_method: z.enum(['pix', 'cartao', 'dinheiro']).optional().nullable(),
});
const failSchema = z.object({
  order_id: z.string().uuid(),
  reason: z.string().trim().min(1).max(500),
});
const closeSchema = z.object({
  km_end: z.coerce.number().min(0).max(9_999_999).optional().nullable(),
  fuel_spent: z.coerce.number().min(0).max(99_999).optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
});
const photoSchema = z.object({ photoRequestId: z.string().uuid() });

function authOf(request: FastifyRequest): CaixaAuth {
  return (request as CaixaRequest).caixa!;
}

export function registerCaixaDeliveryRoutes(
  fastify: FastifyInstance,
  flagGate: PreHandler,
  requireCaixaAuth: PreHandler,
  requireDeliveries: PreHandler,
): void {
  for (const mime of ['image/jpeg', 'image/png', 'image/webp'] as const) {
    if (!fastify.hasContentTypeParser(mime)) {
      fastify.addContentTypeParser(
        mime,
        { parseAs: 'buffer' },
        (_request, body, done) => done(null, body),
      );
    }
  }

  const logisticsGate: PreHandler = async (_request, reply) => {
    if (!env.MATRIZ_LOGISTICS) await reply.status(404).send({ error: 'not_found' });
  };
  const guarded = [flagGate, logisticsGate, requireCaixaAuth, requireDeliveries];

  fastify.get('/api/caixa/entregas', { preHandler: guarded }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return reply.status(200).send(await getCaixaDeliveries(authOf(request)));
  });

  fastify.post('/api/caixa/entregas/rota/abrir', { preHandler: guarded }, async (request, reply) => {
    const parsed = openSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body' });
    try {
      return reply.status(200).send(await openEntregadorTrip(
        caixaCourierAuth(authOf(request)), parsed.data,
      ));
    } catch (error) {
      if (error instanceof Error && error.message === 'trip_already_open') {
        return reply.status(409).send({ error: error.message });
      }
      if (error instanceof Error && error.message === 'trip_needs_delivery') {
        return reply.status(400).send({ error: error.message });
      }
      throw error;
    }
  });

  fastify.post('/api/caixa/entregas/status', { preHandler: guarded }, async (request, reply) => {
    const parsed = statusSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body' });
    try {
      return reply.status(200).send(await setEntregadorDeliveryStatus(
        caixaCourierAuth(authOf(request)), parsed.data,
      ));
    } catch (error) {
      if (error instanceof Error && error.message === 'delivery_not_found') {
        return reply.status(404).send({ error: error.message });
      }
      throw error;
    }
  });

  fastify.post('/api/caixa/entregas/nao-entregue', { preHandler: guarded }, async (request, reply) => {
    const parsed = failSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body' });
    try {
      return reply.status(200).send(await reportEntregadorFail(
        caixaCourierAuth(authOf(request)), parsed.data,
      ));
    } catch (error) {
      if (error instanceof Error && error.message === 'delivery_not_found') {
        return reply.status(404).send({ error: error.message });
      }
      throw error;
    }
  });

  fastify.post('/api/caixa/entregas/rota/fechar', { preHandler: guarded }, async (request, reply) => {
    const parsed = closeSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body' });
    try {
      return reply.status(200).send(await closeEntregadorTrip(
        caixaCourierAuth(authOf(request)), parsed.data,
      ));
    } catch (error) {
      if (error instanceof Error && error.message === 'trip_not_found') {
        return reply.status(404).send({ error: error.message });
      }
      if (error instanceof TripHasUnresolvedDeliveriesError) {
        return reply.status(409).send({
          error: 'trip_has_unresolved_deliveries', deliveries: error.deliveries,
        });
      }
      throw error;
    }
  });

  fastify.post('/api/caixa/entregas/rota/comprovante', {
    preHandler: guarded,
    bodyLimit: PHOTO_MAX_UPLOAD_BYTES,
  }, async (request, reply) => {
    if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
      return reply.status(415).send({ error: 'not_an_image' });
    }
    let photo;
    try {
      photo = await reencodePhoto(request.body);
    } catch (error) {
      if (error instanceof PhotoRejectedError) {
        return reply.status(415).send({ error: error.reason });
      }
      throw error;
    }
    let receipt;
    try {
      receipt = await addEntregadorReceipt(
        caixaCourierAuth(authOf(request)), { bytes: photo.bytes, mime: photo.mime },
      );
    } catch (error) {
      if (error instanceof Error && error.message === 'trip_not_found') {
        return reply.status(404).send({ error: error.message });
      }
      if (error instanceof Error && error.message === 'receipt_limit') {
        return reply.status(400).send({ error: 'receipt_limit' });
      }
      if (error instanceof ReceiptExactDuplicateError) {
        return reply.status(409).send({ error: 'receipt_exact_duplicate',
          duplicate_trip_number: error.duplicateTripNumber });
      }
      throw error;
    }
    let ai: object = {
      ai_status: receipt.ai_status,
      workflow_status: receipt.workflow_status,
    };
    if (env.MATRIZ_RECEIPT_AI && !receipt.duplicate) {
      ai = await extractReceiptSuggestion({
        receipt_id: receipt.receipt_id, bytes: photo.bytes, mime: photo.mime,
      });
    }
    request.log.info({ receiptId: receipt.receipt_id }, 'caixa comprovante de rota anexado');
    return reply.status(receipt.duplicate ? 200 : 201).send({
      ok: true, receipt_id: receipt.receipt_id, duplicate: receipt.duplicate, ...ai,
    });
  });

  fastify.get('/api/caixa/entregas/fotos/:photoRequestId', {
    preHandler: guarded,
  }, async (request, reply) => {
    const parsed = photoSchema.safeParse(request.params);
    if (!parsed.success) return reply.status(404).send({ error: 'photo_not_found' });
    const photo = await getEntregadorProductPhotoImage(
      caixaCourierAuth(authOf(request)), parsed.data.photoRequestId,
    );
    if (!photo) return reply.status(404).send({ error: 'photo_not_found' });
    return reply.header('Content-Type', photo.mime)
      .header('Cache-Control', 'private, no-store').status(200).send(photo.bytes);
  });

}

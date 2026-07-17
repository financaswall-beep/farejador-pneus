// Obra 300 (2026-07-05): fatia da PORTARIA da matriz — logística (0121): abrir/pendurar/
// fechar rota + comprovantes (upload blindado + leitura por IA). Schemas vêm de
// ./route-logistica.js (içados lá). Corpo VERBATIM das linhas 948-1115 do pré-obra.
import type { FastifyInstance } from 'fastify';
import { getAdminContext, requireAdminAuth } from '../auth.js';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';
import { PHOTO_MAX_UPLOAD_BYTES, PhotoRejectedError, reencodePhoto } from '../../parceiro/photo-upload.js';
import { addMatrizTripReceipt, attachOrderToMatrizTrip, closeMatrizTrip,
  getMatrizTripReceiptImage, openMatrizTrip, ReceiptExactDuplicateError,
  approveMatrizTripReceipt, rejectMatrizTripReceipt } from './queries.js';
import { extractReceiptSuggestion } from './receipt-ai-flow.js';
import { mapWriteError, operatorLabel } from './route-helpers.js';
import { abrirRotaSchema, aprovarComprovanteSchema, comprovanteIdParamsSchema,
  comprovanteParamsSchema, fecharRotaSchema, lerComprovanteSchema,
  pendurarRotaSchema, rejeitarComprovanteSchema } from './route-logistica.js';

export async function registerPainelLogisticaRotas(fastify: FastifyInstance): Promise<void> {
  fastify.post('/admin/api/logistica/rotas', { preHandler: requireAdminAuth }, async (request, reply) => {
    if (!env.MATRIZ_LOGISTICS) return reply.status(404).send({ error: 'logistics_disabled' });
    const parsed = abrirRotaSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const result = await openMatrizTrip({
        ...parsed.data,
        created_by: operatorLabel(request),
      });
      return reply.status(201).send({ created: true, ...result });
    } catch (err) {
      if (err instanceof Error && err.message === 'trip_needs_delivery') {
        return reply.status(400).send({ error: 'trip_needs_delivery' });
      }
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel logistica abrir rota failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // PENDURA uma entrega numa rota JÁ ABERTA (o "pendurar depois" — decisão do dono
  // 07-03c). Mesma amarra do vínculo na abertura; só entrega da main, fora de rota,
  // em rota aberta.
  fastify.post('/admin/api/logistica/rotas/pendurar', { preHandler: requireAdminAuth }, async (request, reply) => {
    if (!env.MATRIZ_LOGISTICS) return reply.status(404).send({ error: 'logistics_disabled' });
    const parsed = pendurarRotaSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const result = await attachOrderToMatrizTrip(parsed.data);
      return reply.status(200).send({ attached: true, ...result });
    } catch (err) {
      if (err instanceof Error && (err.message === 'trip_not_open' || err.message === 'delivery_not_found')) {
        return reply.status(404).send({ error: err.message });
      }
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel logistica pendurar rota failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // FECHA a rota (km final + gasolina + observação). O valor informado continua
  // operacional; só uma aprovação humana de comprovante pode criar dinheiro.
  fastify.post('/admin/api/logistica/rotas/fechar', { preHandler: requireAdminAuth }, async (request, reply) => {
    if (!env.MATRIZ_LOGISTICS) return reply.status(404).send({ error: 'logistics_disabled' });
    const parsed = fecharRotaSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const result = await closeMatrizTrip(parsed.data);
      return reply.status(200).send({ closed: true, ...result });
    } catch (err) {
      if (err instanceof Error && err.message === 'trip_not_found') {
        return reply.status(404).send({ error: 'trip_not_found' });
      }
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel logistica fechar rota failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // Comprovante da rota: corpo = bytes da imagem. Valida tipo REAL + re-encoda
  // (funil blindado da foto). Com a IA ligada, tenta ler JÁ na resposta.
  fastify.post('/admin/api/logistica/rotas/:tripId/comprovante', {
    preHandler: requireAdminAuth,
    bodyLimit: PHOTO_MAX_UPLOAD_BYTES,
  }, async (request, reply) => {
    if (!env.MATRIZ_LOGISTICS) return reply.status(404).send({ error: 'logistics_disabled' });
    const params = comprovanteParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(404).send({ error: 'trip_not_found' });

    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.status(415).send({ error: 'not_an_image' });
    }
    let photo;
    try {
      photo = await reencodePhoto(body);
    } catch (err) {
      if (err instanceof PhotoRejectedError) {
        return reply.status(415).send({ error: err.reason });
      }
      throw err;
    }

    let receipt;
    try {
      receipt = await addMatrizTripReceipt({
        trip_id: params.data.tripId,
        bytes: photo.bytes,
        mime: photo.mime,
        actor_label: operatorLabel(request),
        upload_source: 'admin',
      });
    } catch (err) {
      if (err instanceof Error && err.message === 'trip_not_found') {
        return reply.status(404).send({ error: 'trip_not_found' });
      }
      if (err instanceof Error && err.message === 'receipt_limit') {
        return reply.status(400).send({ error: 'receipt_limit' });
      }
      if (err instanceof ReceiptExactDuplicateError) {
        return reply.status(409).send({ error: 'receipt_exact_duplicate',
          duplicate_trip_number: err.duplicateTripNumber });
      }
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel logistica comprovante failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }

    // IA inline (o painel espera com spinner). Erro de transporte NÃO derruba o
    // upload: o comprovante fica 'pending' com "ler de novo" na tela.
    let ai: object = { ai_status: receipt.ai_status,
      workflow_status: receipt.workflow_status };
    if (env.MATRIZ_RECEIPT_AI && !receipt.duplicate) {
      ai = await extractReceiptSuggestion({ receipt_id: receipt.receipt_id,
        bytes: photo.bytes, mime: photo.mime });
    }
    return reply.status(receipt.duplicate ? 200 : 201).send({ ok: true,
      receipt_id: receipt.receipt_id, duplicate: receipt.duplicate, ...ai });
  });

  // Re-tenta somente a extração. Cada tentativa é preservada e continua sem lançar dinheiro.
  fastify.post('/admin/api/logistica/comprovantes/ler', { preHandler: requireAdminAuth }, async (request, reply) => {
    if (!env.MATRIZ_LOGISTICS || !env.MATRIZ_RECEIPT_AI) return reply.status(404).send({ error: 'receipt_ai_disabled' });
    const parsed = lerComprovanteSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    const img = await getMatrizTripReceiptImage(parsed.data.receipt_id);
    if (!img) return reply.status(404).send({ error: 'receipt_not_found' });
    try {
      const result = await extractReceiptSuggestion({ receipt_id: parsed.data.receipt_id,
        bytes: img.bytes, mime: img.mime });
      if (result.suggestion_status === 'failed') {
        return reply.status(502).send({ error: 'ai_unavailable', ...result });
      }
      return reply.status(200).send({ ok: true, ...result });
    } catch (err) {
      logger.warn({ err, receiptId: parsed.data.receipt_id }, 're-leitura de comprovante falhou');
      return reply.status(502).send({ error: 'ai_unavailable' });
    }
  });

  fastify.post('/admin/api/logistica/comprovantes/aprovar', {
    preHandler: requireAdminAuth,
  }, async (request, reply) => {
    if (!env.MATRIZ_RECEIPT_APPROVAL) {
      return reply.status(404).send({ error: 'receipt_approval_disabled' });
    }
    if (!env.MATRIZ_EXPENSES) {
      return reply.status(409).send({ error: 'receipt_approval_expenses_disabled' });
    }
    const parsed = aprovarComprovanteSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const context = getAdminContext(request);
      const result = await approveMatrizTripReceipt({ ...parsed.data,
        actor_label: operatorLabel(request), actor_admin_id: context.personId });
      return reply.status(200).send({ approved: true, ...result });
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel comprovante aprovar failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  fastify.post('/admin/api/logistica/comprovantes/rejeitar', {
    preHandler: requireAdminAuth,
  }, async (request, reply) => {
    if (!env.MATRIZ_RECEIPT_APPROVAL) {
      return reply.status(404).send({ error: 'receipt_approval_disabled' });
    }
    const parsed = rejeitarComprovanteSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const context = getAdminContext(request);
      const result = await rejectMatrizTripReceipt({ ...parsed.data,
        actor_label: operatorLabel(request), actor_admin_id: context.personId });
      return reply.status(200).send({ rejected: true, ...result });
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel comprovante rejeitar failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // Bytes do comprovante (miniatura/lightbox da rota).
  fastify.get('/admin/api/logistica/comprovantes/:receiptId/imagem', { preHandler: requireAdminAuth }, async (request, reply) => {
    if (!env.MATRIZ_LOGISTICS) return reply.status(404).send({ error: 'logistics_disabled' });
    const params = comprovanteIdParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(404).send({ error: 'receipt_not_found' });
    const img = await getMatrizTripReceiptImage(params.data.receiptId);
    if (!img) return reply.status(404).send({ error: 'receipt_not_found' });
    return reply
      .header('Content-Type', img.mime)
      .header('Cache-Control', 'private, max-age=3600')
      .status(200)
      .send(img.bytes);
  });

  // Cadastro de parceiro (Etapa 1 onboarding): cria unidade + parceiro + LOGIN + cobertura.
  // O token (login) volta em texto SÓ aqui, uma vez. Admin-only.
}

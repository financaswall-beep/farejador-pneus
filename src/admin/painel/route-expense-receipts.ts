import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';
import { rateLimitHit } from '../../shared/rate-limit.js';
import { reencodePhoto, PhotoRejectedError, PHOTO_MAX_UPLOAD_BYTES } from '../../parceiro/photo-upload.js';
import { addExpenseReceipt, expenseReceiptsReady, getExpenseReceipt, getExpenseReceiptImage, receiptForExpense } from './expense-receipts.js';
import { readExpenseReceipt } from './expense-receipt-ai.js';
import { mapWriteError } from './route-helpers.js';

type Gate = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
type Options = { prefix: string; read: Gate[]; write: Gate[]; actor: (request: FastifyRequest) => string };
const params = z.object({ id: z.string().uuid() });

export function registerExpenseReceiptRoutes(app: FastifyInstance, options: Options) {
  for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'application/octet-stream']) {
    if (!app.hasContentTypeParser(mime)) app.addContentTypeParser(mime, { parseAs: 'buffer' }, (_, body, done) => done(null, body));
  }
  const available: Gate = async (_, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!env.MATRIZ_EXPENSES) return reply.code(404).send({ error: 'expenses_disabled' });
    if (!await expenseReceiptsReady()) return reply.code(503).send({ error: 'expense_receipts_unavailable' });
  };
  const limited: Gate = async (request, reply) => {
    if (rateLimitHit(`expense-receipt:${options.actor(request)}`, 20, 5 * 60_000)) {
      return reply.header('Retry-After', '300').code(429).send({ error: 'receipt_rate_limit' });
    }
  };
  const write = [...options.write, available, limited], read = [...options.read, available];
  const fail = (error: unknown, reply: FastifyReply) => {
    if (error instanceof PhotoRejectedError) return reply.code(400).send({ error: error.reason });
    const mapped = mapWriteError(error);
    // Não logar bytes, conteúdo reconhecido ou cabeçalhos de autenticação.
    if (mapped.status >= 500) logger.error({ code: 'expense_receipt_failed' }, 'expense receipt operation failed');
    return reply.code(mapped.status).send({ error: mapped.error });
  };
  app.post(options.prefix + '/comprovantes', { preHandler: write, bodyLimit: PHOTO_MAX_UPLOAD_BYTES }, async (request, reply) => {
    if (!Buffer.isBuffer(request.body) || !request.body.length) return reply.code(400).send({ error: 'image_required' });
    try {
      const image = await reencodePhoto(request.body);
      const result = await addExpenseReceipt(image.bytes, options.actor(request));
      return reply.code(result.duplicate ? 200 : 201).send(result);
    } catch (error) { return fail(error, reply); }
  });
  app.get(options.prefix + '/comprovantes/:id', { preHandler: [...options.write, available] }, async (request, reply) => {
    const p = params.safeParse(request.params);
    if (!p.success) return reply.code(400).send({ error: 'invalid_id' });
    const receipt = await getExpenseReceipt(p.data.id);
    return receipt ? { receipt } : reply.code(404).send({ error: 'expense_receipt_not_found' });
  });
  app.post(options.prefix + '/comprovantes/:id/ler', { preHandler: write }, async (request, reply) => {
    const p = params.safeParse(request.params), body = z.object({ retry: z.boolean().default(false) }).safeParse(request.body ?? {});
    if (!p.success || !body.success) return reply.code(400).send({ error: 'invalid_request' });
    if (!env.MATRIZ_RECEIPT_AI) return reply.code(409).send({ error: 'receipt_ai_disabled' });
    try {
      const receipt = await readExpenseReceipt(p.data.id, body.data.retry);
      return receipt ? { receipt } : reply.code(404).send({ error: 'expense_receipt_not_found' });
    } catch (error) { return fail(error, reply); }
  });
  // Rascunhos só podem ser vistos pelo dono. Documentos de despesas já lançadas seguem o acesso financeiro.
  for (const draft of [false, true]) app.get(options.prefix + '/comprovantes/:id/' + (draft ? 'previa' : 'imagem'),
    { preHandler: draft ? [...options.write, available] : read }, async (request, reply) => {
      const p = params.safeParse(request.params);
      if (!p.success) return reply.code(400).send({ error: 'invalid_id' });
      const image = await getExpenseReceiptImage(p.data.id, !draft);
      if (!image) return reply.code(404).send({ error: 'expense_receipt_not_found' });
      return reply.header('X-Content-Type-Options', 'nosniff').type(image.mime).send(image.bytes);
    });
  app.get(options.prefix + '/:id/comprovante', { preHandler: options.read }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!env.MATRIZ_EXPENSES) return reply.code(404).send({ error: 'expenses_disabled' });
    const p = params.safeParse(request.params);
    if (!p.success) return reply.code(400).send({ error: 'invalid_id' });
    return { receipt: await receiptForExpense(p.data.id) };
  });
}

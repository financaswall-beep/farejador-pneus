/**
 * PORTAL DO ENTREGADOR — /entregas (0125). Fatia C da Logística (0121).
 *
 * Porta SEPARADA do /login dos parceiros e do /admin do dono: página mobile
 * pública + API própria com sessão es_ (nunca aceita token admin; nunca é aceita
 * por requireAdminAuth). Toda a superfície atrás de DUAS flags — off = 404 no
 * preHandler (nem 401: não denuncia que existe). Revisão de segurança 07-04
 * (FIX-ANTES) baked in: posse no WHERE das queries (queries.ts), 401 único no
 * login, sessão morre com o colaborador revogado, não-entregue só REPORTA.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';
import { rateLimitHit } from '../../parceiro/rate-limit.js';
import { reencodePhoto, PhotoRejectedError, PHOTO_MAX_UPLOAD_BYTES } from '../../parceiro/photo-upload.js';
import { readReceiptWithAI } from '../painel/receipt-ai.js';
import { recordReceiptAiResult } from '../painel/queries.js';
import {
  authenticateEntregador,
  validateEntregadorSession,
  revokeEntregadorSession,
  isStaffSessionToken,
  getEntregadorRota,
  openEntregadorTrip,
  setEntregadorDeliveryStatus,
  reportEntregadorFail,
  closeEntregadorTrip,
  addEntregadorReceipt,
  getEntregadorReceiptImage,
  type EntregadorAuth,
} from './queries.js';

const publicDir = path.join(process.cwd(), 'painel', 'public');

// Espelho do login global (login-global.route.ts): 10 tentativas / 5 min por chave.
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_PER_IP = 20;

const usernameField = z.string().trim().min(3).max(60).regex(/^[a-zA-Z0-9._-]+$/, 'usuario_invalido');
const passwordField = z.string().min(6).max(200);
const loginSchema = z.object({ username: usernameField, password: passwordField });

const abrirRotaSchema = z.object({
  km_start: z.coerce.number().min(0).max(9999999).optional().nullable(),
  order_ids: z.array(z.string().uuid()).min(1).max(50),
});
const statusSchema = z.object({
  order_id: z.string().uuid(),
  status: z.enum(['dispatched', 'delivered']),
  payment_method: z.string().max(40).optional().nullable(),
});
const naoEntregueSchema = z.object({
  order_id: z.string().uuid(),
  reason: z.string().trim().min(1).max(500),
});
const fecharRotaSchema = z.object({
  km_end: z.coerce.number().min(0).max(9999999).optional().nullable(),
  fuel_spent: z.coerce.number().min(0).max(99999).optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
});
const receiptIdSchema = z.object({ receiptId: z.string().uuid() });

type RequestWithAuth = FastifyRequest & { entregador?: EntregadorAuth };

async function sendStatic(reply: FastifyReply, file: string, type: string): Promise<FastifyReply> {
  const content = await readFile(path.join(publicDir, file));
  return reply.header('Content-Type', type).header('Cache-Control', 'no-store').send(content);
}

export async function registerEntregadorRoute(fastify: FastifyInstance): Promise<void> {
  // Parsers de imagem (idempotente — o painel pode já ter registrado).
  for (const mime of ['image/jpeg', 'image/png', 'image/webp'] as const) {
    if (!fastify.hasContentTypeParser(mime)) {
      fastify.addContentTypeParser(mime, { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    }
  }

  // PORTÃO DA FLAG: as duas ligadas, senão 404 (invisível). Roda ANTES de tudo.
  const flagGate = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!env.MATRIZ_ENTREGADOR_PORTAL || !env.MATRIZ_LOGISTICS) {
      await reply.status(404).send({ error: 'not_found' });
    }
  };

  // AUTH do portal: bearer es_ (sem fallback) → sessão viva + colaborador ativo.
  const requireEntregadorAuth = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const header = request.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      await reply.status(401).send({ error: 'unauthorized' });
      return;
    }
    const bearer = header.slice(7);
    if (!isStaffSessionToken(bearer)) { // token admin/parceiro/lixo NUNCA vira sessão aqui
      await reply.status(401).send({ error: 'unauthorized' });
      return;
    }
    const auth = await validateEntregadorSession(env.FAREJADOR_ENV, bearer);
    if (!auth) {
      await reply.status(401).send({ error: 'unauthorized' });
      return;
    }
    (request as RequestWithAuth).entregador = auth;
  };

  const authOf = (request: FastifyRequest): EntregadorAuth => (request as RequestWithAuth).entregador!;

  // ── A página (mobile, standalone) — gated pela flag ──
  fastify.get('/entregas', { preHandler: flagGate }, async (_request, reply) =>
    sendStatic(reply, 'entregas.html', 'text/html; charset=utf-8'));
  fastify.get('/entregas.js', { preHandler: flagGate }, async (_request, reply) =>
    sendStatic(reply, 'entregas.js', 'text/javascript; charset=utf-8'));

  // ── Login: usuário+senha → sessão es_. Resposta ÚNICA 401. ──
  fastify.post('/api/entregas/login', { preHandler: flagGate }, async (request, reply) => {
    if (rateLimitHit(`entregador:ip:${request.ip}`, LOGIN_MAX_PER_IP, LOGIN_WINDOW_MS)) {
      return reply.status(429).send({ error: 'too_many_attempts' });
    }
    const parsed = loginSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(401).send({ error: 'invalid_credentials' });
    if (rateLimitHit(`entregador:user:${parsed.data.username.toLowerCase()}`, LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS)) {
      return reply.status(429).send({ error: 'too_many_attempts' });
    }
    const auth = await authenticateEntregador(env.FAREJADOR_ENV, parsed.data.username, parsed.data.password);
    if (!auth) return reply.status(401).send({ error: 'invalid_credentials' });
    return reply.status(200).send(auth);
  });

  // ── Logout ──
  fastify.post('/api/entregas/logout', { preHandler: [flagGate, requireEntregadorAuth] }, async (request, reply) => {
    const header = request.headers.authorization ?? '';
    await revokeEntregadorSession(env.FAREJADOR_ENV, header.slice(7));
    return reply.status(200).send({ ok: true });
  });

  // ── A rota dele (card financeiramente cego) ──
  fastify.get('/api/entregas/minha-rota', { preHandler: [flagGate, requireEntregadorAuth] }, async (request, reply) => {
    const auth = authOf(request);
    const rota = await getEntregadorRota(auth);
    return reply.status(200).send({ display_name: auth.displayName, ...rota });
  });

  // ── Abrir a rota (km inicial + entregas escolhidas) ──
  fastify.post('/api/entregas/rota/abrir', { preHandler: [flagGate, requireEntregadorAuth] }, async (request, reply) => {
    const parsed = abrirRotaSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    try {
      const result = await openEntregadorTrip(authOf(request), parsed.data);
      return reply.status(200).send({ opened: true, ...result });
    } catch (err) {
      if (err instanceof Error && err.message === 'trip_already_open') {
        return reply.status(409).send({ error: 'trip_already_open' });
      }
      if (err instanceof Error && err.message === 'trip_needs_delivery') {
        return reply.status(400).send({ error: 'trip_needs_delivery' });
      }
      logger.error({ err }, 'entregador abrir rota failed');
      return reply.status(500).send({ error: 'internal_error' });
    }
  });

  // ── Saiu / Entregue ──
  fastify.post('/api/entregas/status', { preHandler: [flagGate, requireEntregadorAuth] }, async (request, reply) => {
    const parsed = statusSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    try {
      const result = await setEntregadorDeliveryStatus(authOf(request), parsed.data);
      return reply.status(200).send({ ok: true, ...result });
    } catch (err) {
      if (err instanceof Error && err.message === 'delivery_not_found') {
        return reply.status(404).send({ error: 'delivery_not_found' });
      }
      logger.error({ err }, 'entregador status failed');
      return reply.status(500).send({ error: 'internal_error' });
    }
  });

  // ── Não entregue (só REPORTA — o dono confirma no painel) ──
  fastify.post('/api/entregas/nao-entregue', { preHandler: [flagGate, requireEntregadorAuth] }, async (request, reply) => {
    const parsed = naoEntregueSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    try {
      const result = await reportEntregadorFail(authOf(request), parsed.data);
      return reply.status(200).send({ ok: true, ...result });
    } catch (err) {
      if (err instanceof Error && err.message === 'delivery_not_found') {
        return reply.status(404).send({ error: 'delivery_not_found' });
      }
      logger.error({ err }, 'entregador nao-entregue failed');
      return reply.status(500).send({ error: 'internal_error' });
    }
  });

  // ── Fechar a rota (km final, gasolina, obs) ──
  fastify.post('/api/entregas/rota/fechar', { preHandler: [flagGate, requireEntregadorAuth] }, async (request, reply) => {
    const parsed = fecharRotaSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    try {
      const result = await closeEntregadorTrip(authOf(request), parsed.data);
      return reply.status(200).send({ closed: true, ...result });
    } catch (err) {
      if (err instanceof Error && err.message === 'trip_not_found') {
        return reply.status(404).send({ error: 'trip_not_found' });
      }
      logger.error({ err }, 'entregador fechar rota failed');
      return reply.status(500).send({ error: 'internal_error' });
    }
  });

  // ── Comprovante da rota: bytes → funil blindado de foto → IA (se ligada) ──
  fastify.post('/api/entregas/rota/comprovante', {
    preHandler: [flagGate, requireEntregadorAuth],
    bodyLimit: PHOTO_MAX_UPLOAD_BYTES,
  }, async (request, reply) => {
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) return reply.status(415).send({ error: 'not_an_image' });
    let photo;
    try {
      photo = await reencodePhoto(body);
    } catch (err) {
      if (err instanceof PhotoRejectedError) return reply.status(415).send({ error: err.reason });
      throw err;
    }
    let receipt;
    try {
      receipt = await addEntregadorReceipt(authOf(request), { bytes: photo.bytes, mime: photo.mime });
    } catch (err) {
      if (err instanceof Error && err.message === 'trip_not_found') {
        return reply.status(404).send({ error: 'trip_not_found' });
      }
      logger.error({ err }, 'entregador comprovante failed');
      return reply.status(500).send({ error: 'internal_error' });
    }
    // IA inline (mesma régua do painel): erro de transporte NÃO derruba o upload.
    let ai: { ai_status: string; ai_summary?: string | null } = { ai_status: receipt.ai_status };
    if (env.MATRIZ_RECEIPT_AI) {
      try {
        const reading = await readReceiptWithAI(photo.bytes, photo.mime);
        const recorded = await recordReceiptAiResult({
          receipt_id: receipt.receipt_id,
          result: reading.kind === 'parsed'
            ? { kind: 'parsed', category: reading.category, amount: reading.amount, summary: reading.summary }
            : { kind: 'unreadable', summary: reading.summary },
        });
        ai = { ai_status: recorded.ai_status, ai_summary: reading.summary };
      } catch (err) {
        logger.warn({ err, receiptId: receipt.receipt_id }, 'entregador leitura de comprovante falhou (fica pending)');
      }
    }
    return reply.status(201).send({ ok: true, receipt_id: receipt.receipt_id, ...ai });
  });

  // ── Imagem do comprovante (miniatura) — COM posse ──
  fastify.get('/api/entregas/comprovantes/:receiptId/imagem', {
    preHandler: [flagGate, requireEntregadorAuth],
  }, async (request, reply) => {
    const params = receiptIdSchema.safeParse(request.params);
    if (!params.success) return reply.status(404).send({ error: 'receipt_not_found' });
    const img = await getEntregadorReceiptImage(authOf(request), params.data.receiptId);
    if (!img) return reply.status(404).send({ error: 'receipt_not_found' });
    return reply
      .header('Content-Type', img.mime)
      .header('Cache-Control', 'private, max-age=3600')
      .status(200)
      .send(img.bytes);
  });
}

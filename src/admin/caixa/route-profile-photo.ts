import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../../shared/config/env.js';
import { rateLimitHit } from '../../shared/rate-limit.js';
import { compactProfilePhoto, PROFILE_UPLOAD_MAX, ProfilePhotoError } from '../../photos/profile-codec.js';
import { profilePhotoPath, ProfilePhotoStorage } from '../../photos/profile-storage.js';
import type { CaixaAuth } from './queries.js';

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
type Request = FastifyRequest & { caixa?: CaixaAuth };

export function registerCaixaProfilePhotoRoutes(app: FastifyInstance, flagGate: Guard, requireCaixaAuth: Guard): void {
  const storage = new ProfilePhotoStorage(), preHandler = [flagGate, requireCaixaAuth];
  for (const mime of ['image/jpeg', 'image/png', 'image/webp']) {
    if (!app.hasContentTypeParser(mime)) app.addContentTypeParser(mime,
      { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  }
  function headers(reply: FastifyReply) {
    return reply.header('Cache-Control', 'private, no-store').header('Vary', 'Authorization')
      .header('X-Content-Type-Options', 'nosniff');
  }
  function failed(reply: FastifyReply, error: unknown) {
    const known = error instanceof ProfilePhotoError;
    return reply.code(known ? error.status : 503).send({ error: known ? error.message : 'photo_storage_unavailable' });
  }
  app.get('/api/caixa/profile/photo', { preHandler }, async (request: Request, reply) => {
    headers(reply);
    try {
      const bytes = await storage.read(profilePhotoPath(env.FAREJADOR_ENV, request.caixa!.personId));
      return bytes ? reply.type('image/webp').send(bytes) : reply.code(204).send();
    } catch (error) { return failed(reply, error); }
  });
  app.put('/api/caixa/profile/photo', { preHandler, bodyLimit: PROFILE_UPLOAD_MAX }, async (request: Request, reply) => {
    headers(reply);
    if (rateLimitHit('profile-photo:' + env.FAREJADOR_ENV + ':' + request.caixa!.personId, 10, 60_000)) {
      return reply.code(429).header('Retry-After', '60').send({ error: 'too_many_attempts' });
    }
    if (!Buffer.isBuffer(request.body) || !request.body.length) return reply.code(415).send({ error: 'not_an_image' });
    try {
      const bytes = await compactProfilePhoto(request.body);
      await storage.put(profilePhotoPath(env.FAREJADOR_ENV, request.caixa!.personId), bytes);
      return reply.type('image/webp').send(bytes);
    } catch (error) { return failed(reply, error); }
  });
}

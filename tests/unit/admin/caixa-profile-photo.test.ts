import Fastify, { type FastifyRequest } from 'fastify';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/shared/config/env.js', () => ({ env: { FAREJADOR_ENV: 'test' } }));
import { registerCaixaProfilePhotoRoutes } from '../../../src/admin/caixa/route-profile-photo.js';
import { ProfilePhotoStorage } from '../../../src/photos/profile-storage.js';
import { ProfilePhotoError } from '../../../src/photos/profile-codec.js';

const person = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
function app() {
  const server = Fastify();
  registerCaixaProfilePhotoRoutes(server, async () => {}, async (request, reply) => {
    if (!['Bearer conta-A', 'Bearer conta-B'].includes(request.headers.authorization || '')) {
      await reply.code(401).send({ error: 'unauthorized' }); return;
    }
    (request as FastifyRequest & { caixa: { personId: string } }).caixa = { personId: person(request.headers.authorization === 'Bearer conta-A' ? 1 : 2) };
  });
  return server;
}
afterEach(() => vi.restoreAllMocks());
describe('foto do próprio usuário da Matriz', () => {
  it('exige autenticação na leitura e gravação', async () => {
    const storage = vi.spyOn(ProfilePhotoStorage.prototype, 'read'); const server = app();
    try {
      expect((await server.inject('/api/caixa/profile/photo')).statusCode).toBe(401);
      expect((await server.inject({ method: 'PUT', url: '/api/caixa/profile/photo', headers: { 'content-type': 'image/jpeg' }, payload: Buffer.from('x') })).statusCode).toBe(401);
      expect(storage).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });
  it('deriva o caminho da sessão e ignora uma tentativa de escolher outra conta', async () => {
    const storage = vi.spyOn(ProfilePhotoStorage.prototype, 'read').mockResolvedValue(Buffer.from('photo'));
    const server = app();
    try {
      const response = await server.inject({ url: '/api/caixa/profile/photo?person_id=' + person(2), headers: { authorization: 'Bearer conta-A' } });
      expect(storage).toHaveBeenLastCalledWith('test/' + person(1) + '/profile.webp');
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.headers.vary).toBe('Authorization');
      expect(response.headers['content-type']).toBe('image/webp');
      await server.inject({ url: '/api/caixa/profile/photo', headers: { authorization: 'Bearer conta-B' } });
      expect(storage).toHaveBeenLastCalledWith('test/' + person(2) + '/profile.webp');
    } finally { await server.close(); }
  });
  it('diferencia conta sem foto de storage fora do ar', async () => {
    const storage = vi.spyOn(ProfilePhotoStorage.prototype, 'read').mockResolvedValue(null); const server = app();
    try {
      expect((await server.inject({ url: '/api/caixa/profile/photo', headers: { authorization: 'Bearer conta-A' } })).statusCode).toBe(204);
      storage.mockRejectedValueOnce(new ProfilePhotoError('photo_storage_unavailable'));
      const response = await server.inject({ url: '/api/caixa/profile/photo', headers: { authorization: 'Bearer conta-A' } });
      expect(response.statusCode).toBe(503); expect(response.json()).toEqual({ error: 'photo_storage_unavailable' });
    } finally { await server.close(); }
  });
  it('valida e compacta a imagem antes de persistir e devolve o WebP salvo', async () => {
    const put = vi.spyOn(ProfilePhotoStorage.prototype, 'put').mockResolvedValue(); const server = app();
    const image = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#807064' } }).jpeg().toBuffer();
    try {
      const response = await server.inject({ method: 'PUT', url: '/api/caixa/profile/photo', headers: { authorization: 'Bearer conta-A', 'content-type': 'image/jpeg' }, payload: image });
      expect(response.statusCode).toBe(200); expect(response.headers['content-type']).toBe('image/webp');
      expect(put).toHaveBeenCalledOnce(); expect(put.mock.calls[0][0]).toBe('test/' + person(1) + '/profile.webp');
      expect(response.rawPayload).toEqual(put.mock.calls[0][1]);
      expect(await sharp(response.rawPayload).metadata()).toMatchObject({ format: 'webp', width: 512, height: 512 });
      const invalid = await server.inject({ method: 'PUT', url: '/api/caixa/profile/photo', headers: { authorization: 'Bearer conta-A', 'content-type': 'image/jpeg' }, payload: Buffer.from('not a photo') });
      expect(invalid.statusCode).toBe(415); expect(put).toHaveBeenCalledOnce();
    } finally { await server.close(); }
  });
});

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../shared/config/env.js';
import { rateLimitHit } from '../shared/rate-limit.js';
import { getPartnerContext,requirePartnerAuth,requireScreen,type PartnerAuthedRequest } from './auth.js';
import { completePhotoUpload,photoUploadState,PhotoUploadError,reservePhotoUpload } from '../photos/uploads.js';
import { photoStorageConfigured } from '../photos/storage.js';

const uuid = z.string().uuid().transform(value=>value.toLowerCase());
const params = z.object({ photoRequestId: uuid, uploadId: uuid });
export function registerPartnerPhotoStorageRoutes(app: FastifyInstance) {
  const base='/parceiro/:slug/api/operacao/pedidos-foto/:photoRequestId/uploads/:uploadId';
  for (const action of ['reserve','complete','state'] as const) {
    app.route({ method: action==='state' ? 'GET' : 'POST', url: base + (action==='state' ? '' : `/${action}`),
      preHandler: [requirePartnerAuth,requireScreen('vendas')], bodyLimit: 1024,
      handler: async (request: PartnerAuthedRequest,reply) => {
        reply.header('Cache-Control','no-store');
        if (!env.PHOTO_REQUESTS || !photoStorageConfigured()) return reply.code(404).send({ error:'feature_off' });
        const input=params.safeParse(request.params);
        if (!input.success) return reply.code(404).send({ error:'photo_request_not_found' });
        const ctx=getPartnerContext(request);
        if (rateLimitHit(`photo-storage:${action}:${ctx.tokenId}`,action==='state'?120:30,60_000)) {
          return reply.code(429).send({ error:'rate_limited' });
        }
        try {
          const args=[ctx,input.data.photoRequestId,input.data.uploadId] as const;
          return await (action==='reserve'?reservePhotoUpload(...args)
            : action==='complete'?completePhotoUpload(...args):photoUploadState(...args));
        } catch (error) {
          if (error instanceof PhotoUploadError) return reply.code(error.status).send({ error:error.code });
          request.log.error({ err:error },'photo storage request failed');
          return reply.code(503).send({ error:'photo_storage_unavailable' });
        }
      },
    });
  }
}

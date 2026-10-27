import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from 'fastify';
import { z } from 'zod';
import { requireAdminOwner, getAdminContext } from '../auth.js';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { rateLimitHit } from '../../shared/rate-limit.js';
import { publisherConfig, requirePublisher, requireSending } from '../../marketing/publisher/config.js';
import { PublisherError, idSchema, draftSchema, uploadSchema, finalizeSchema } from '../../marketing/publisher/model.js';
import { listMedia, reserveMedia, finalizeMedia, type Media } from '../../marketing/publisher/media.js';
import { preparedPublishPath, preparedDimensions, MAX_PHOTO_SOURCE_BYTES } from '../../marketing/publisher/media-formats.js';
import { listPosts, saveDraft, submitPost, postAction } from '../../marketing/publisher/posts.js';
import { PublisherStorage } from '../../marketing/publisher/storage.js';
import { deleteMedia } from '../../marketing/publisher/cleanup.js';
import { PublisherGraph } from '../../marketing/publisher/graph.js';
import { reconcileDestination, reconciliationSchema } from '../../marketing/publisher/reconciliation.js';
import { generateCaption } from '../../marketing/publisher/caption.js';
import { reschedulePost } from '../../marketing/publisher/reschedule.js';
export interface MarketingPublisherAccess {
    base?: string;
    preHandler?: RouteShorthandOptions['preHandler'];
    actor?: (request: FastifyRequest) => { displayName: string; personId?: string | null };
}
const params = z.object({ id: idSchema }).strict();
const submitSchema = z.object({ version: z.number().int().min(1), scheduled_at: z.string().datetime({ offset: true }).nullable() }).strict();
type Handler = (request: FastifyRequest) => Promise<unknown>;
function guarded(handler: Handler, enabled = true) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.header('Cache-Control', 'no-store');
        try {
            if (enabled)
                requirePublisher();
            return await handler(request);
        }
        catch (error) {
            if (error instanceof z.ZodError)
                return reply.code(400).send({ error: 'invalid_publisher_request' });
            if (error instanceof PublisherError)
                return reply.code(error.status).send({ error: error.code });
            // Erros de Storage/Graph não podem revelar tokens, URLs assinadas ou dados do operador.
            return reply.code(503).send({ error: 'publisher_unavailable' });
        }
    };
}
export async function registerMarketingPublisher(app: FastifyInstance, access: MarketingPublisherAccess = {}): Promise<void> {
    const base = access.base ?? '/admin/api/marketing/publisher';
    const actor = access.actor ?? getAdminContext;
    const options = { preHandler: access.preHandler ?? requireAdminOwner };
    const environment = env.FAREJADOR_ENV;
    app.get(base, options, guarded(async () => {
        const config = publisherConfig();
        const schema = await pool.query<{
            ready: boolean;
        }>(`SELECT to_regclass('ops.publisher_posts') IS NOT NULL
      AND EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema='ops' AND table_name='publisher_media' AND column_name='inspection')
      AND EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema='ops' AND table_name='publisher_destinations' AND column_name='retry_attempts') ready`);
        const ready = schema.rows[0]?.ready === true;
        if (!config.enabled || !ready)
            return { config: { ...config, schema_ready: ready }, posts: [], media: [], warnings: [] };
        const [posts, media, bucket] = await Promise.allSettled([
            listPosts(pool, environment),
            config.storage_ready ? listMedia(pool, environment) : Promise.resolve([]),
            config.storage_ready ? new PublisherStorage().assertPrivateBucket() : Promise.resolve(null),
        ]);
        const storageReady = config.storage_ready && bucket.status === 'fulfilled';
        const bucketMax = bucket.status === 'fulfilled' ? bucket.value?.maxBytes : null;
        return { config: { ...config, schema_ready: ready,
                storage_credentials_ready: config.storage_ready, storage_ready: storageReady,
                sending: config.sending && storageReady,
                max_file_bytes: Math.min(config.max_file_bytes, bucketMax ?? config.max_file_bytes),
                max_photo_bytes: Math.min(MAX_PHOTO_SOURCE_BYTES, config.max_file_bytes, bucketMax ?? config.max_file_bytes),
                bucket_max_file_bytes: bucketMax ?? null },
            posts: posts.status === 'fulfilled' ? posts.value : [],
            media: media.status === 'fulfilled' ? media.value : [],
            warnings: [...(posts.status === 'rejected' ? ['publisher_posts_unavailable'] : []),
                ...(media.status === 'rejected' ? ['publisher_library_unavailable'] : []),
                ...(bucket.status === 'rejected' ? ['publisher_storage_unavailable'] : [])] };
    }, false));
    app.post(base + '/connections', options, guarded(async () => ({ connections: await new PublisherGraph().connections() })));
    app.post(base + '/media', options, guarded(async (request) => {
        return reserveMedia(pool, environment, uploadSchema.parse(request.body), actor(request).displayName);
    }));
    app.post(base + '/media/:id/complete', { ...options, bodyLimit: 400000 }, guarded(async (request) => {
        return finalizeMedia(pool, environment, params.parse(request.params).id, finalizeSchema.parse(request.body));
    }));
    app.post(base + '/media/:id/preview', options, guarded(async (request) => {
        const id = params.parse(request.params).id;
        const body = z.object({ format: z.enum(['feed', 'story', 'reel']).optional() }).strict().parse(request.body ?? {});
        const media = (await pool.query<Media>(`SELECT kind,publish_path,original_path,width,height,inspection FROM ops.publisher_media
      WHERE environment=$1 AND id=$2 AND status='ready'`, [environment, id])).rows[0];
        if (!media)
            throw new PublisherError('publisher_media_not_found', 404);
        const format = body.format ?? (media.kind === 'photo' ? 'feed' : 'reel');
        if (media.kind === 'video' && format === 'feed' || media.kind === 'photo' && format === 'reel') throw new PublisherError('publisher_format_incompatible', 400);
        return { url: await new PublisherStorage().signedUrl(preparedPublishPath(media, format), 900), format, ...preparedDimensions(media, format) };
    }));
    app.post(base + '/media/:id/remove', options, guarded(async (request) => {
        await deleteMedia(pool, environment, params.parse(request.params).id, false);
        return { removed: true };
    }));
    app.put(base + '/posts/:id', options, guarded(async (request) => {
        return saveDraft(pool, environment, params.parse(request.params).id, draftSchema.parse(request.body), actor(request).displayName);
    }));
    app.post(base + '/posts/:id/submit', options, guarded(async (request) => {
        requireSending();
        const body = submitSchema.parse(request.body);
        return submitPost(pool, environment, params.parse(request.params).id, body.version, body.scheduled_at, actor(request).displayName);
    }));
    app.post(base + '/posts/:id/reschedule', options, guarded(async request => {
        requireSending();
        const body = z.object({ version: z.number().int().min(1), scheduled_at: z.string().datetime({ offset: true }) }).strict().parse(request.body);
        return reschedulePost(pool, environment, params.parse(request.params).id, body.version, body.scheduled_at, actor(request).displayName);
    }));
    app.post(base + '/posts/:id/action', options, guarded(async (request) => {
        const body = z.object({ action: z.enum(['cancel', 'retry']) }).strict().parse(request.body);
        if (body.action === 'retry')
            requireSending();
        return postAction(pool, environment, params.parse(request.params).id, body.action, actor(request).displayName);
    }));
    app.post(base + '/posts/:id/reconcile', options, guarded(async (request) => {
        return reconcileDestination(pool, environment, params.parse(request.params).id, reconciliationSchema.parse(request.body), actor(request).displayName, new PublisherGraph());
    }));
    app.post(base + '/caption', options, guarded(async (request) => {
        const body = z.object({ brief: z.string().trim().min(5).max(1200) }).strict().parse(request.body);
        const operator = actor(request);
        if (rateLimitHit(`publisher-caption:${operator.personId ?? request.ip}`, 10, 3600000))
            throw new PublisherError('publisher_ai_rate_limit', 429);
        return generateCaption(pool, environment, body.brief);
    }));
}

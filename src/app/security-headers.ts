import type { FastifyInstance, FastifyReply } from 'fastify';

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://unpkg.com https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
].join('; ');

function storageOrigin(storageUrl?: string): string | undefined {
  if (!storageUrl) return undefined;
  try {
    const url = new URL(storageUrl);
    if (url.protocol !== 'https:' || /[\s*;'\"]/.test(url.origin)
      || url.username || url.password || url.pathname !== '/'
      || url.search || url.hash) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export function applySecurityHeaders(
  reply: FastifyReply, production: boolean, mapsPanel = false, publisherStorageUrl?: string, photoUploadApp = false,
): void {
  let policy = mapsPanel ? CONTENT_SECURITY_POLICY
    .replace("https://cdn.jsdelivr.net", "https://cdn.jsdelivr.net https://maps.googleapis.com https://maps.gstatic.com")
    .replace("connect-src 'self'", "connect-src 'self' https://maps.googleapis.com https://maps.gstatic.com https://*.googleapis.com") : CONTENT_SECURITY_POLICY;
  const origin = (mapsPanel || photoUploadApp) ? storageOrigin(publisherStorageUrl) : undefined;
  if (origin) {
    policy = policy.replace("connect-src 'self'", `connect-src 'self' ${origin}`)
      .replace("media-src 'self' blob:", `media-src 'self' blob: ${origin}`);
  }
  // A route may deliberately set a stricter policy than the panel defaults.
  if (!reply.hasHeader?.('Content-Security-Policy')) reply.header('Content-Security-Policy', policy);
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', mapsPanel ? 'strict-origin-when-cross-origin' : 'no-referrer');
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self)');
  reply.header('Cross-Origin-Opener-Policy', 'same-origin');
  reply.header('Cross-Origin-Resource-Policy', 'same-origin');
  if (production) {
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

export function registerSecurityHeaders(
  fastify: FastifyInstance, production: boolean, publisherStorageUrl?: string,
): void {
  fastify.addHook('onSend', async (request, reply, payload) => {
    applySecurityHeaders(reply, production, /^\/admin\/painel\/?(?:\?|$)/.test(request.url), publisherStorageUrl,
      /^\/(?:operacao\/?|parceiro\/[^/]+\/?)(?:\?|$)/.test(request.url));
    return payload;
  });
}

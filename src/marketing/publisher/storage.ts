import { env } from '../../shared/config/env.js';
import { PublisherError } from './model.js';

type FetchBody = NonNullable<Parameters<typeof fetch>[1]>['body'];
export interface BucketPolicy { maxBytes: number | null; allowedMimes: string[] | null }
export interface UploadSession {
  upload_url: string;
  resumable: { endpoint: string; token: string; bucket: string; object: string; chunk_size: number };
}

/** A chave administrativa permanece no servidor; assinaturas autorizam somente um objeto. */
export class PublisherStorage {
  constructor(private fetcher: typeof fetch = fetch) {}

  private base(): string {
    if (!env.SUPABASE_STORAGE_URL || !env.SUPABASE_STORAGE_SERVICE_KEY) {
      throw new PublisherError('publisher_storage_missing', 503);
    }
    return `${env.SUPABASE_STORAGE_URL.replace(/\/$/, '')}/storage/v1`;
  }

  private object(path: string): string {
    const allowed = /^(prod|test)\/[a-f0-9-]{36}\/(original\.(jpg|png|webp|heic|heif|mp4|mov)|publish\.jpg|thumbnail\.jpg)$/;
    if (!allowed.test(path)) throw new PublisherError('publisher_storage_path', 400);
    return `${env.MARKETING_PUBLICATIONS_BUCKET}/${path}`;
  }

  private async request(path: string, method = 'GET', body?: string | Uint8Array,
    headers: Record<string, string> = {}, objectLookup = false): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.base()}${path}`, {
        method, redirect: 'error',
        headers: {
          Authorization: `Bearer ${env.SUPABASE_STORAGE_SERVICE_KEY}`,
          apikey: env.SUPABASE_STORAGE_SERVICE_KEY!, 'Content-Type': 'application/json', ...headers,
        },
        ...(body ? { body: body as FetchBody } : {}), signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new PublisherError('publisher_storage_unavailable', 502);
    }
    if (!response.ok) {
      throw await this.responseError(response, objectLookup);
    }
    return response;
  }

  /** O Storage pode usar HTTP 400 para NoSuchKey; só o código lógico confirma ausência. */
  private async responseError(response: Response, objectLookup: boolean): Promise<PublisherError> {
    const rejected = new PublisherError('publisher_storage_rejected', 502);
    const reader = response.body?.getReader();
    if (!reader) return rejected;
    const parts: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 8 * 1024) return rejected;
        parts.push(part.value);
      }
      const data: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'));
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        const error = data as { code?: unknown; error?: unknown; statusCode?: unknown };
        const missingCode = error.code === 'NoSuchKey' || error.code === undefined && error.error === 'not_found';
        const missing = missingCode && (error.statusCode === '404' || error.statusCode === 404);
        if (objectLookup && [400, 404].includes(response.status) && missing) {
          return new PublisherError('publisher_storage_object_missing', 404);
        }
      }
      return rejected;
    } catch {
      return rejected;
    } finally {
      // Nem o corpo do provedor nem falhas de cancelamento devem escapar no erro público.
      try { await reader.cancel(); } catch { /* A resposta já foi abortada. */ }
    }
  }

  private signed(value: unknown, expected: string): string {
    if (typeof value !== 'string' || !value.startsWith(expected)) {
      throw new PublisherError('publisher_storage_response', 502);
    }
    const result = new URL(this.base() + value);
    if (result.origin !== new URL(this.base()).origin) throw new PublisherError('publisher_storage_response', 502);
    return result.toString();
  }

  async assertPrivateBucket(): Promise<BucketPolicy> {
    const data = await (await this.request(`/bucket/${env.MARKETING_PUBLICATIONS_BUCKET}`)).json() as {
      public?: boolean; file_size_limit?: number | string | null; allowed_mime_types?: unknown;
    };
    if (data.public !== false) throw new PublisherError('publisher_bucket_must_be_private', 503);
    const limit = data.file_size_limit == null ? null : Number(data.file_size_limit);
    if (limit !== null && (!Number.isSafeInteger(limit) || limit <= 0)) {
      throw new PublisherError('publisher_storage_response', 502);
    }
    return {
      maxBytes: limit,
      allowedMimes: Array.isArray(data.allowed_mime_types)
        ? data.allowed_mime_types.filter((mime): mime is string => typeof mime === 'string') : null,
    };
  }

  async uploadSession(path: string): Promise<UploadSession> {
    const target = this.object(path);
    const data = await (await this.request(`/object/upload/sign/${target}`, 'POST', '{}')).json() as { url?: unknown };
    const upload_url = this.signed(data.url, `/object/upload/sign/${target}?`);
    const token = new URL(upload_url).searchParams.get('token');
    if (!token) throw new PublisherError('publisher_storage_response', 502);
    return { upload_url, resumable: {
      endpoint: `${this.base()}/upload/resumable/sign`, token,
      bucket: env.MARKETING_PUBLICATIONS_BUCKET, object: path, chunk_size: 6 * 1024 * 1024,
    } };
  }

  async uploadUrl(path: string): Promise<string> {
    return (await this.uploadSession(path)).upload_url;
  }

  async signedUrl(path: string, expires = 3600): Promise<string> {
    const target = this.object(path);
    const data = await (await this.request(`/object/sign/${target}`, 'POST', JSON.stringify({ expiresIn: expires })))
      .json() as { signedURL?: unknown };
    return this.signed(data.signedURL, `/object/sign/${target}?`);
  }

  async info(path: string): Promise<{ bytes: number; mime: string }> {
    const data = await (await this.request(`/object/info/${this.object(path)}`, 'GET', undefined, {}, true)).json() as {
      size?: unknown; content_type?: unknown;
    };
    const bytes = typeof data.size === 'number' ? data.size : NaN;
    if (!Number.isSafeInteger(bytes) || bytes < 1 || typeof data.content_type !== 'string' || !data.content_type) {
      throw new PublisherError('publisher_storage_response', 502);
    }
    return { bytes, mime: data.content_type.toLowerCase() };
  }

  private async body(response: Response, max: number, truncate = false): Promise<Buffer> {
    const reader = response.body?.getReader();
    if (!reader) throw new PublisherError('publisher_storage_response', 502);
    let bytes = 0;
    const parts: Uint8Array[] = [];
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        const available = max - bytes;
        if (part.value.byteLength > available && !truncate) throw new PublisherError('publisher_media_too_large', 413);
        parts.push(part.value.subarray(0, available));
        bytes += Math.min(part.value.byteLength, available);
        if (bytes >= max && truncate) break;
      }
    } catch (error) {
      if (error instanceof PublisherError) throw error;
      throw new PublisherError('publisher_storage_unavailable', 502);
    } finally {
      await reader.cancel();
    }
    return Buffer.concat(parts);
  }

  async read(path: string, max: number, range = false): Promise<Buffer> {
    const response = await this.request(`/object/${this.object(path)}`, 'GET', undefined,
      range ? { Range: `bytes=0-${max - 1}` } : {}, true);
    return this.body(response, max, range);
  }

  /** O proxy de inspeção aceita somente intervalos limitados, com resposta 206 exata. */
  async readRange(path: string, start: number, end: number, total: number): Promise<Buffer> {
    if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start || end >= total || end - start >= 8 * 1024 * 1024) {
      throw new PublisherError('publisher_media_range_invalid', 400);
    }
    const response = await this.request(`/object/${this.object(path)}`, 'GET', undefined,
      { Range: `bytes=${start}-${end}` }, true);
    if (response.status !== 206 || response.headers.get('Content-Range') !== `bytes ${start}-${end}/${total}`) {
      await response.body?.cancel();
      throw new PublisherError('publisher_storage_range_required', 502);
    }
    const result = await this.body(response, end - start + 1);
    if (result.length !== end - start + 1) throw new PublisherError('publisher_upload_mismatch', 400);
    return result;
  }

  async put(path: string, body: Buffer, mime = 'image/jpeg'): Promise<void> {
    const response = await this.request(`/object/${this.object(path)}`, 'POST', body,
      { 'Content-Type': mime, 'x-upsert': 'true' });
    await response.body?.cancel();
  }

  async remove(paths: string[]): Promise<void> {
    if (!paths.length) return;
    paths.forEach(path => this.object(path));
    const response = await this.request(`/object/${env.MARKETING_PUBLICATIONS_BUCKET}`, 'DELETE',
      JSON.stringify({ prefixes: [...new Set(paths)] }));
    await response.body?.cancel();
  }
}

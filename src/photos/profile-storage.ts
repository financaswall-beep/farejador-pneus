import { randomUUID } from 'node:crypto';
import { env } from '../shared/config/env.js';
import { PROFILE_PHOTO_MAX, ProfilePhotoError } from './profile-codec.js';

export const PROFILE_PHOTO_BUCKET = 'farejador-profile-photos';
const validPath = /^(prod|test)\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/profile\.webp$/;

export function profilePhotoPath(environment: 'prod' | 'test', personId: string): string {
  const path = `${environment}/${personId}/profile.webp`;
  if (!validPath.test(path)) throw new ProfilePhotoError('invalid_photo_path', 400);
  return path;
}

/** Objeto privado único por conta; substituição nativa evita versões e referências no banco. */
export class ProfilePhotoStorage {
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  private async request(path: string, method = 'GET', body?: Buffer | string, upsert = false) {
    if (!env.SUPABASE_STORAGE_URL || !env.SUPABASE_STORAGE_SERVICE_KEY) {
      throw new ProfilePhotoError('photo_storage_unavailable');
    }
    return this.fetcher(env.SUPABASE_STORAGE_URL.replace(/\/$/, '') + '/storage/v1' + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { Authorization: 'Bearer ' + env.SUPABASE_STORAGE_SERVICE_KEY,
        apikey: env.SUPABASE_STORAGE_SERVICE_KEY,
        'Content-Type': Buffer.isBuffer(body) ? 'image/webp' : 'application/json',
        ...(upsert ? { 'x-upsert': 'true' } : {}) },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : new Uint8Array(body) } : {}),
    });
  }
  private async privateBucket(create: boolean): Promise<boolean> {
    let response = await this.request('/bucket/' + PROFILE_PHOTO_BUCKET);
    const missing = response.status === 404 || (response.status === 400 && await response.clone().json()
      .then(value => { const error = value as { statusCode?: unknown; code?: unknown };
        return String(error?.statusCode) === '404' || ['NoSuchBucket', 'not_found'].includes(String(error?.code)); })
      .catch(() => false));
    if (missing) {
      await response.body?.cancel();
      if (!create) return false;
      const created = await this.request('/bucket', 'POST', JSON.stringify({
        id: PROFILE_PHOTO_BUCKET, name: PROFILE_PHOTO_BUCKET, public: false,
        file_size_limit: PROFILE_PHOTO_MAX, allowed_mime_types: ['image/webp'],
      }));
      await created.body?.cancel();
      response = await this.request('/bucket/' + PROFILE_PHOTO_BUCKET);
    }
    if (!response.ok) { await response.body?.cancel(); throw new ProfilePhotoError('photo_storage_unavailable'); }
    const policy = await response.json() as { public?: unknown; file_size_limit?: unknown; allowed_mime_types?: unknown };
    if (policy.public !== false || Number(policy.file_size_limit) !== PROFILE_PHOTO_MAX
      || JSON.stringify(policy.allowed_mime_types) !== JSON.stringify(['image/webp'])) {
      throw new ProfilePhotoError('profile_bucket_policy_invalid');
    }
    return true;
  }
  async put(path: string, bytes: Buffer): Promise<void> {
    if (!validPath.test(path) || bytes.length > PROFILE_PHOTO_MAX) throw new ProfilePhotoError('invalid_photo', 415);
    await this.privateBucket(true);
    const response = await this.request('/object/' + PROFILE_PHOTO_BUCKET + '/' + path, 'POST', bytes, true);
    await response.body?.cancel();
    if (!response.ok) throw new ProfilePhotoError('photo_storage_unavailable');
  }
  async read(path: string): Promise<Buffer | null> {
    if (!validPath.test(path)) throw new ProfilePhotoError('invalid_photo_path', 400);
    if (!await this.privateBucket(false)) return null;
    const response = await this.request('/object/' + PROFILE_PHOTO_BUCKET + '/' + path + '?cacheNonce=' + randomUUID());
    if (response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as { statusCode?: unknown; code?: unknown };
      if (String(error.statusCode) === '404' || ['NoSuchKey', 'not_found'].includes(String(error.code))) return null;
      throw new ProfilePhotoError('photo_storage_unavailable');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ProfilePhotoError('photo_storage_unavailable');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.length;
        if (size > PROFILE_PHOTO_MAX) throw new ProfilePhotoError('invalid_stored_photo');
        chunks.push(part.value);
      }
    } finally { await reader.cancel(); }
    if (!size) throw new ProfilePhotoError('invalid_stored_photo');
    return Buffer.concat(chunks);
  }
}

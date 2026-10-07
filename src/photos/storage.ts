import { env } from '../shared/config/env.js';

export const TIRE_PHOTO_BUCKET = 'farejador-tire-photos';
export const PHOTO_UPLOAD_MAX = 2 * 1024 * 1024;
const uuid = '[a-f0-9-]{36}';
const allowedPath = new RegExp(`^(prod|test)/${uuid}/${uuid}/${uuid}/(upload\\.jpg|photo\\.webp)$`);
type FetchBody = NonNullable<Parameters<typeof fetch>[1]>['body'];
export const photoStorageConfigured = () => Boolean(env.SUPABASE_STORAGE_URL && env.SUPABASE_STORAGE_SERVICE_KEY);

export class PhotoStorageError extends Error {
  constructor(public readonly status: number) { super('photo_storage_unavailable'); }
}

/** Bucket privado exclusivo de fotos operacionais. Nenhum nome ou telefone no caminho. */
export class TirePhotoStorage {
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  private base() {
    if (!photoStorageConfigured()) throw new PhotoStorageError(503);
    return `${env.SUPABASE_STORAGE_URL!.replace(/\/$/, '')}/storage/v1`;
  }
  private object(path: string) {
    if (!allowedPath.test(path)) throw new Error('invalid_tire_photo_path');
    return `${TIRE_PHOTO_BUCKET}/${path}`;
  }
  private async request(path: string, method = 'GET', body?: string | Buffer,
    headers: Record<string, string> = {}) {
    const response = await this.fetcher(this.base() + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${env.SUPABASE_STORAGE_SERVICE_KEY}`,
        apikey: env.SUPABASE_STORAGE_SERVICE_KEY!, 'Content-Type': 'application/json', ...headers },
      ...(body !== undefined ? { body: body as FetchBody } : {}),
    });
    return response;
  }
  private async checked(path: string, method = 'GET', body?: string | Buffer,
    headers?: Record<string, string>) {
    const response = await this.request(path, method, body, headers);
    if (!response.ok) { await response.body?.cancel(); throw new PhotoStorageError(response.status); }
    return response;
  }
  async ensureBucket() {
    let response = await this.request(`/bucket/${TIRE_PHOTO_BUCKET}`);
    if (response.status === 404 || response.status === 400) {
      await response.body?.cancel();
      const created = await this.request('/bucket', 'POST', JSON.stringify({
        id: TIRE_PHOTO_BUCKET, name: TIRE_PHOTO_BUCKET, public: false,
        file_size_limit: PHOTO_UPLOAD_MAX, allowed_mime_types: ['image/jpeg', 'image/webp'],
      }));
      // Outra réplica pode ter criado o bucket entre o GET e o POST.
      await created.body?.cancel();
      response = await this.checked(`/bucket/${TIRE_PHOTO_BUCKET}`);
    } else if (!response.ok) { await response.body?.cancel(); throw new PhotoStorageError(response.status); }
    const bucket = await response.json() as { public?: boolean; file_size_limit?: unknown; allowed_mime_types?: unknown };
    const mimes = Array.isArray(bucket.allowed_mime_types) ? bucket.allowed_mime_types : [];
    if (bucket.public !== false || Number(bucket.file_size_limit) !== PHOTO_UPLOAD_MAX
      || !Array.isArray(bucket.allowed_mime_types)
      || bucket.allowed_mime_types.length !== 2
      || !['image/jpeg', 'image/webp'].every(m => mimes.includes(m))) {
      throw new Error('tire_photo_bucket_policy_invalid');
    }
  }
  async uploadUrl(path: string) {
    const target = this.object(path);
    const response = await this.checked(`/object/upload/sign/${target}`, 'POST', '{}');
    const data = await response.json() as { url?: unknown };
    if (typeof data.url !== 'string' || !data.url.startsWith(`/object/upload/sign/${target}?`)) {
      throw new Error('invalid_tire_photo_signed_url');
    }
    return this.base() + data.url;
  }
  async read(path: string, max = PHOTO_UPLOAD_MAX) {
    const response = await this.checked(`/object/${this.object(path)}`);
    const reader = response.body?.getReader();
    if (!reader) throw new PhotoStorageError(502);
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        length += chunk.value.length;
        if (length > max) throw new Error('tire_photo_too_large');
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel(); }
    return Buffer.concat(chunks);
  }
  async put(path: string, bytes: Buffer) {
    const response = await this.checked(`/object/${this.object(path)}`, 'POST', bytes,
      { 'Content-Type': 'image/webp', 'x-upsert': 'true' });
    await response.body?.cancel();
  }
  async remove(paths: string[]) {
    if (!paths.length) return;
    paths.forEach(path => this.object(path));
    const response = await this.checked(`/object/${TIRE_PHOTO_BUCKET}`, 'DELETE', JSON.stringify({ prefixes: paths }));
    await response.body?.cancel();
  }
}

export interface StoredTirePhoto { bytes: Buffer | null; mime: string; storage_path?: string | null }
export async function readStoredTirePhoto(photo: StoredTirePhoto | undefined): Promise<{ bytes: Buffer; mime: string } | null> {
  if (!photo) return null;
  if (photo.bytes) return { bytes: photo.bytes, mime: photo.mime };
  if (photo.storage_path) return { bytes: await new TirePhotoStorage().read(photo.storage_path), mime: photo.mime };
  return null;
}

import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
vi.mock('../../../src/shared/config/env.js', () => ({ env: {
  MARKETING_MEDIA_MAX_MB: 500, MARKETING_LIBRARY_MAX_MB: 20000,
} }));
import { assertUploadPolicy, listMedia } from '../../../src/marketing/publisher/media.js';
import type { PublisherStorage } from '../../../src/marketing/publisher/storage.js';

describe('Biblioteca de mídia', () => {
  it('isola miniatura quebrada, limita concorrência e não expõe caminhos privados', async () => {
    const rows = Array.from({ length: 25 }, (_, index) => ({ id: String(index), name: 'video.mp4',
      kind: 'video', status: 'ready', original_path: 'secret-original', publish_path: 'secret-publish',
      thumbnail_path: `thumb-${index}`, inspection: { verified: true } }));
    const pool = { query: vi.fn().mockResolvedValue({ rows }) } as unknown as Pool;
    let active = 0; let peak = 0;
    const storage = { signedUrl: vi.fn(async (path: string) => {
      active++; peak = Math.max(active, peak);
      await new Promise(resolve => setTimeout(resolve, 2)); active--;
      if (path === 'thumb-3') throw new Error('storage details and credentials');
      return `https://storage.invalid/${path}`;
    }) } as unknown as PublisherStorage;
    const result = await listMedia(pool, 'test', storage);
    expect(result).toHaveLength(25);
    expect(result[3]).toMatchObject({ id: '3', thumbnail_url: null, thumbnail_error: true });
    expect(result[4]).toMatchObject({ thumbnail_url: 'https://storage.invalid/thumb-4', thumbnail_error: false });
    expect(peak).toBeLessThanOrEqual(8);
    expect(JSON.stringify(result)).not.toMatch(/secret-|credentials|thumbnail_path/);
  });
  it('lista envios pendentes e permite reprocessar arquivo já completo ou vídeo legado', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [
      { id: '1', status: 'uploading', kind: 'video', upload_completed_at: null },
      { id: '2', status: 'failed', kind: 'photo', upload_completed_at: new Date() },
      { id: '3', status: 'ready', kind: 'video', inspection: {} },
    ] }) } as unknown as Pool;
    const result = await listMedia(pool, 'test', {} as PublisherStorage);
    expect(result.map(item => item.can_finalize)).toEqual([true, true, true]);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("status IN ('ready','uploading','failed')"), ['test']);
  });
  it('bloqueia tamanho/tipo incompatível com o bucket antes de transmitir o arquivo', () => {
    expect(() => assertUploadPolicy({ maxBytes: 10, allowedMimes: null }, 11, 'video/mp4')).toThrow('publisher_bucket_file_limit');
    expect(() => assertUploadPolicy({ maxBytes: null, allowedMimes: ['image/jpeg'] }, 8, 'video/mp4')).toThrow('publisher_bucket_mime_rejected');
    expect(() => assertUploadPolicy({ maxBytes: 100, allowedMimes: ['video/*'] }, 8, 'video/quicktime')).not.toThrow();
  });
});

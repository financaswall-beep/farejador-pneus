import { beforeAll, afterAll, beforeEach, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import type { Pool } from 'pg';
const { config } = vi.hoisted(() => ({ config: { MARKETING_MEDIA_MAX_MB: 500, MARKETING_LIBRARY_MAX_MB: 20000 } }));
vi.mock('../../src/shared/config/env.js', () => ({ env: config }));
import { reserveMedia, finalizeMedia, listMedia } from '../../src/marketing/publisher/media.js';
import { PublisherStorage } from '../../src/marketing/publisher/storage.js';
import { PublisherError } from '../../src/marketing/publisher/model.js';
import { cleanupMedia, deleteMedia } from '../../src/marketing/publisher/cleanup.js';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

class TestStorage extends PublisherStorage {
  objects = new Map<string, { data: Buffer; mime: string }>();
  policy = { maxBytes: null as number | null, allowedMimes: null as string[] | null };
  override assertPrivateBucket = vi.fn(async () => this.policy);
  override uploadSession = vi.fn(async (path: string) => ({ upload_url: 'https://storage.invalid/signed',
    resumable: { endpoint: 'https://storage.invalid/storage/v1/upload/resumable', token: 'scoped',
      bucket: 'publisher', object: path, chunk_size: 6291456 } }));
  override info = vi.fn(async (path: string) => {
    const object = this.objects.get(path);
    if (!object) throw new PublisherError('publisher_storage_object_missing', 404);
    return { bytes: object.data.length, mime: object.mime };
  });
  override read = vi.fn(async (path: string, max: number, range = false) => {
    const object = this.objects.get(path);
    if (!object) throw new PublisherError('publisher_storage_object_missing', 404);
    if (!range && object.data.length > max) throw new PublisherError('publisher_media_too_large', 413);
    return range ? object.data.subarray(0, max) : object.data;
  });
  override put = vi.fn(async (path: string, body: Buffer, mime = 'image/jpeg') => {
    this.objects.set(path, { data: body, mime });
  });
  override signedUrl = vi.fn(async () => 'https://storage.invalid/thumbnail');
  override remove = vi.fn(async (paths: string[]) => { for (const path of paths) this.objects.delete(path); });
}
let pool: Pool;
let embedded: any;
let container: IntegrationDb | undefined;
let storage: TestStorage;
beforeAll(async () => {
  if (process.env.PUBLISHER_EMBEDDED_DB === '1') {
    const packagePath = pathToFileURL(resolve('artifacts/publisher-validation/node_modules/@electric-sql/pglite/dist/index.js')).href;
    const { PGlite } = await import(packagePath);
    embedded = new PGlite();
    await embedded.exec(`CREATE TYPE env_t AS ENUM('prod','test');CREATE SCHEMA ops;CREATE SCHEMA analytics;
      CREATE ROLE farejador_partner_app;CREATE FUNCTION ops.enforce_environment_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.environment IS DISTINCT FROM OLD.environment THEN RAISE EXCEPTION 'environment_immutable';END IF;RETURN NEW;END $$;`);
    for (const file of ['0246_marketing_publisher.sql', '0247_marketing_publisher_recovery.sql']) {
      await embedded.exec(await readFile(`db/migrations/${file}`, 'utf8'));
    }
    const query = async (sql: string, params?: unknown[]) => {
      const result = await embedded.query(sql, params);
      return { ...result, rowCount: result.rows.length || result.affectedRows || 0 };
    };
    pool = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
  } else { container = await startPostgres(); pool = container.pool; }
}, 180000);
afterAll(async () => { if (container) await stopPostgres(container); if (embedded) await embedded.close(); });
beforeEach(async () => {
  await pool.query('TRUNCATE ops.publisher_events,ops.publisher_destinations,ops.publisher_posts,ops.publisher_media');
  storage = new TestStorage(); config.MARKETING_LIBRARY_MAX_MB = 20000;
});
async function jpeg() {
  return sharp({ create: { width: 800, height: 1000, channels: 3, background: '#abc' } }).jpeg().toBuffer();
}
async function reserve(body: Buffer, mime: 'image/jpeg' | 'video/mp4' = 'image/jpeg', id = randomUUID()) {
  const data = { id, name: mime === 'image/jpeg' ? 'photo.jpg' : 'video.mp4', mime, bytes: body.length };
  const reservation = await reserveMedia(pool, 'test', data, 'owner', storage);
  return { data, reservation };
}

it('reserva uma vez, renova assinatura da mesma mídia e aplica o limite real do bucket', async () => {
  const image = await jpeg();
  const { data, reservation } = await reserve(image);
  const again = await reserveMedia(pool, 'test', data, 'owner', storage);
  expect(again.resumable.object).toBe(reservation.resumable.object);
  expect((await pool.query('SELECT count(*)::int count FROM ops.publisher_media')).rows[0].count).toBe(1);
  await expect(reserveMedia(pool, 'test', { ...data, bytes: data.bytes + 1 }, 'owner', storage)).rejects.toThrow('publisher_upload_conflict');
  storage.policy.maxBytes = 10;
  await expect(reserve(image)).rejects.toThrow('publisher_bucket_file_limit');
  expect(storage.uploadSession).toHaveBeenCalledTimes(2);
});
it('ao retomar reconhece arquivo remoto completo mesmo sem registro local de conclusão', async () => {
  const image = await jpeg();
  const { data, reservation } = await reserve(image);
  storage.objects.set(reservation.resumable.object, { data: image, mime: 'image/jpeg' });
  const renewed = await reserveMedia(pool, 'test', data, 'owner', storage);
  expect(renewed.already_uploaded).toBe(true);
  expect((await pool.query('SELECT count(*)::int count FROM ops.publisher_media')).rows[0].count).toBe(1);
  expect((await pool.query('SELECT upload_completed_at FROM ops.publisher_media')).rows[0].upload_completed_at).toBeNull();
});
it('foto é decodificada/converte no servidor e finalização repetida não regrava arquivos', async () => {
  const image = await jpeg();
  const { reservation } = await reserve(image);
  storage.objects.set(reservation.resumable.object, { data: image, mime: 'image/jpeg' });
  await finalizeMedia(pool, 'test', reservation.id, { width: 1, height: 1, duration: 999 }, storage);
  const row = (await pool.query('SELECT * FROM ops.publisher_media')).rows[0];
  expect(row).toMatchObject({ status: 'ready', width: 800, height: 1000, duration: null, inspection: { verified: true }, error_code: null });
  expect(row.upload_completed_at).toBeTruthy();
  expect((await sharp(storage.objects.get(row.publish_path)!.data).metadata()).format).toBe('jpeg');
  await finalizeMedia(pool, 'test', reservation.id, {}, storage);
  expect(storage.put).toHaveBeenCalledTimes(2);
});
it('falha após upload preserva o original e permite finalizar sem enviar novamente', async () => {
  const image = await jpeg();
  const { reservation } = await reserve(image);
  storage.objects.set(reservation.resumable.object, { data: image, mime: 'image/jpeg' });
  storage.put.mockRejectedValueOnce(new PublisherError('publisher_storage_unavailable', 502));
  await expect(finalizeMedia(pool, 'test', reservation.id, {}, storage)).rejects.toThrow('publisher_storage_unavailable');
  const failed = (await listMedia(pool, 'test', storage))[0];
  expect(failed).toMatchObject({ status: 'failed', can_finalize: true, error_code: 'publisher_storage_unavailable' });
  const uploads = storage.uploadSession.mock.calls.length;
  await finalizeMedia(pool, 'test', reservation.id, {}, storage);
  expect(storage.uploadSession).toHaveBeenCalledTimes(uploads);
  expect((await pool.query('SELECT status,error_code FROM ops.publisher_media')).rows[0]).toEqual({ status: 'ready', error_code: null });
});
it('upload incompleto fica visível e não é falsamente marcado como arquivo recebido', async () => {
  const { reservation } = await reserve(await jpeg());
  await expect(finalizeMedia(pool, 'test', reservation.id, {}, storage)).rejects.toThrow('publisher_upload_incomplete');
  expect((await listMedia(pool, 'test', storage))[0]).toMatchObject({ status: 'uploading', can_finalize: true,
    error_code: 'publisher_upload_incomplete', upload_completed_at: null });
});
it('objeto ausente limpa timestamp antigo e permite retomar sem alegar que já foi recebido', async () => {
  const { data, reservation } = await reserve(await jpeg());
  await pool.query(`UPDATE ops.publisher_media SET status='failed',upload_completed_at=now() WHERE id=$1`, [reservation.id]);
  await expect(finalizeMedia(pool, 'test', reservation.id, {}, storage)).rejects.toThrow('publisher_upload_incomplete');
  expect((await pool.query('SELECT status,upload_completed_at FROM ops.publisher_media')).rows[0])
    .toEqual({ status: 'uploading', upload_completed_at: null });
  const renewed = await reserveMedia(pool, 'test', data, 'owner', storage);
  expect(renewed.already_uploaded).toBe(false);
  expect(renewed.resumable.object).toBe(reservation.resumable.object);
});
it('quota inclui arquivos com processamento falho e libera espaço somente após exclusão', async () => {
  config.MARKETING_LIBRARY_MAX_MB = 10;
  const { reservation } = await reserve(await jpeg());
  await pool.query(`UPDATE ops.publisher_media SET status='failed' WHERE id=$1`, [reservation.id]);
  await expect(reserve(await jpeg())).rejects.toThrow('publisher_library_full');
  await pool.query(`UPDATE ops.publisher_media SET status='deleted' WHERE id=$1`, [reservation.id]);
  await expect(reserve(await jpeg())).resolves.toBeDefined();
});
it('miniaturas preservadas no histórico continuam contando na quota da biblioteca', async () => {
  const image = await jpeg();
  const { reservation } = await reserve(image);
  storage.objects.set(reservation.resumable.object, { data: image, mime: 'image/jpeg' });
  await finalizeMedia(pool, 'test', reservation.id, {}, storage);
  await deleteMedia(pool, 'test', reservation.id, false, storage);
  config.MARKETING_LIBRARY_MAX_MB = 8.1;
  await expect(reserve(image)).rejects.toThrow('publisher_library_full');
});
it('o tipo/tamanho declarado e a separação de ambientes são verificados na finalização', async () => {
  const image = await jpeg();
  const { reservation } = await reserve(image);
  storage.objects.set(reservation.resumable.object, { data: image, mime: 'image/png' });
  await expect(finalizeMedia(pool, 'test', reservation.id, {}, storage)).rejects.toThrow('publisher_upload_mismatch');
  await expect(finalizeMedia(pool, 'prod', reservation.id, {}, storage)).rejects.toThrow('publisher_media_not_found');
  expect((await pool.query('SELECT upload_completed_at FROM ops.publisher_media')).rows[0].upload_completed_at).toBeNull();
});
it('vídeo usa medição e miniatura do servidor; uma recuperação não confia nos dados do navegador', async () => {
  const body = Buffer.alloc(32); body.write('ftyp', 4);
  const { reservation } = await reserve(body, 'video/mp4');
  storage.objects.set(reservation.resumable.object, { data: body, mime: 'video/mp4' });
  const thumbnail = await jpeg();
  const inspector = vi.fn().mockResolvedValue({ width: 1080, height: 1920, duration: 50, thumbnail,
    inspection: { verified: true, video_codec: 'hevc', fps: 30, bit_rate: 8_000_000 } });
  await finalizeMedia(pool, 'test', reservation.id, { width: 1, height: 1, duration: 1, thumbnail: 'malicious' }, storage, inspector);
  expect(inspector).toHaveBeenCalledWith(storage, reservation.resumable.object, 32);
  expect((await pool.query('SELECT width,height,duration,inspection FROM ops.publisher_media')).rows[0])
    .toMatchObject({ width: 1080, height: 1920, inspection: { verified: true, video_codec: 'hevc', fps: 30 } });
});
it('limpeza preserva arquivo completo com conversão falha e remove somente órfão incompleto após 24h', async () => {
  const { reservation: received } = await reserve(await jpeg());
  await pool.query(`UPDATE ops.publisher_media SET status='failed',upload_completed_at=now(),updated_at=now()-interval '3 days'
    WHERE id=$1`, [received.id]);
  const { reservation: pending } = await reserve(await jpeg());
  await pool.query(`UPDATE ops.publisher_media SET updated_at=now()-interval '4 hours' WHERE id=$1`, [pending.id]);
  await cleanupMedia(pool, 'test', storage);
  expect(storage.remove).not.toHaveBeenCalled();
  await expect(deleteMedia(pool, 'test', pending.id, false, storage)).rejects.toThrow('publisher_upload_active');
  await pool.query(`UPDATE ops.publisher_media SET updated_at=now()-interval '25 hours' WHERE id=$1`, [pending.id]);
  await cleanupMedia(pool, 'test', storage);
  expect(storage.remove).toHaveBeenCalledOnce();
  expect((await pool.query('SELECT status FROM ops.publisher_media WHERE id=$1', [pending.id])).rows[0].status).toBe('deleted');
  expect((await pool.query('SELECT status FROM ops.publisher_media WHERE id=$1', [received.id])).rows[0].status).toBe('failed');
});
it('limpeza reconhece upload concluído antes da queda de energia e não apaga o arquivo', async () => {
  const image = await jpeg();
  const { reservation } = await reserve(image);
  storage.objects.set(reservation.resumable.object, { data: image, mime: 'image/jpeg' });
  await pool.query(`UPDATE ops.publisher_media SET updated_at=now()-interval '25 hours' WHERE id=$1`, [reservation.id]);
  await cleanupMedia(pool, 'test', storage);
  expect(storage.remove).not.toHaveBeenCalled();
  expect((await listMedia(pool, 'test', storage))[0]).toMatchObject({ status: 'failed',
    can_finalize: true, error_code: 'publisher_processing_required' });
  await finalizeMedia(pool, 'test', reservation.id, {}, storage);
  expect((await pool.query('SELECT status FROM ops.publisher_media')).rows[0].status).toBe('ready');
});

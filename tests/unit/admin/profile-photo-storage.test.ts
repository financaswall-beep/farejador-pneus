import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/shared/config/env.js', () => ({ env: {
  SUPABASE_STORAGE_URL: 'https://storage.example', SUPABASE_STORAGE_SERVICE_KEY: 'fixture-private-key',
} }));
import { compactProfilePhoto, PROFILE_PHOTO_MAX, PROFILE_UPLOAD_MAX } from '../../../src/photos/profile-codec.js';
import { profilePhotoPath, ProfilePhotoStorage } from '../../../src/photos/profile-storage.js';

const person = '00000000-0000-4000-8000-000000000001';
const policy = () => Response.json({ public: false, file_size_limit: PROFILE_PHOTO_MAX, allowed_mime_types: ['image/webp'] });
const fetcher = (fn: (...args: any[]) => any) => vi.fn(fn) as unknown as typeof fetch;

describe('foto pessoal compacta e privada', () => {
  it('grava WebP quadrado sem metadados nem orientação pendente', async () => {
    const source = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#908075' } })
      .withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const bytes = await compactProfilePhoto(source), meta = await sharp(bytes).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: 512, height: 512 });
    expect(meta.exif).toBeUndefined(); expect(meta.orientation).toBeUndefined();
    expect(bytes.length).toBeLessThan(PROFILE_PHOTO_MAX);
  });
  it('rejeita arquivos disfarçados e corpos acima do limite', async () => {
    await expect(compactProfilePhoto(Buffer.from('<svg/>'))).rejects.toMatchObject({ status: 415 });
    await expect(compactProfilePhoto(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).rejects.toMatchObject({ status: 415 });
    await expect(compactProfilePhoto(Buffer.alloc(PROFILE_UPLOAD_MAX + 1))).rejects.toMatchObject({ status: 413 });
  });
  it('separa ambientes e impede usar nomes, URLs ou caminhos arbitrários', () => {
    expect(profilePhotoPath('prod', person)).not.toBe(profilePhotoPath('test', person));
    expect(profilePhotoPath('test', person)).toBe('test/' + person + '/profile.webp');
    expect(() => profilePhotoPath('test', '../outra-pessoa')).toThrow('invalid_photo_path');
  });
  it('mantém só um objeto por pessoa com upsert e bucket privado', async () => {
    const mock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 })).mockResolvedValueOnce(policy())
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const storage = new ProfilePhotoStorage(mock as unknown as typeof fetch);
    await storage.put(profilePhotoPath('test', person), Buffer.from('webp-fixture'));
    const create = JSON.parse(mock.mock.calls[1][1].body);
    expect(create).toMatchObject({ public: false, file_size_limit: PROFILE_PHOTO_MAX, allowed_mime_types: ['image/webp'] });
    const [url, request] = mock.mock.calls[3];
    expect(url).toBe('https://storage.example/storage/v1/object/farejador-profile-photos/test/' + person + '/profile.webp');
    expect(request.headers).toMatchObject({ 'x-upsert': 'true', 'Content-Type': 'image/webp' });
    expect(request.redirect).toBe('error');
  });
  it('não usa um bucket que esteja público nem tenta escrever nele', async () => {
    const mock = vi.fn().mockResolvedValue(Response.json({ public: true, file_size_limit: PROFILE_PHOTO_MAX, allowed_mime_types: ['image/webp'] }));
    const storage = new ProfilePhotoStorage(mock as unknown as typeof fetch);
    await expect(storage.put(profilePhotoPath('test', person), Buffer.from('photo'))).rejects.toThrow('profile_bucket_policy_invalid');
    expect(mock).toHaveBeenCalledOnce();
  });
  it('não cria bucket durante leitura e distingue ausência de indisponibilidade', async () => {
    const missing = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    expect(await new ProfilePhotoStorage(missing as unknown as typeof fetch).read(profilePhotoPath('test', person))).toBeNull();
    expect(missing).toHaveBeenCalledOnce();
    const unavailable = fetcher(async () => new Response(null, { status: 403 }));
    await expect(new ProfilePhotoStorage(unavailable).read(profilePhotoPath('test', person))).rejects.toThrow('photo_storage_unavailable');
    const badRequest = fetcher(async () => Response.json({ message: 'upstream error' }, { status: 400 }));
    await expect(new ProfilePhotoStorage(badRequest).read(profilePhotoPath('test', person))).rejects.toThrow('photo_storage_unavailable');
  });
  it('limita também o download se a resposta upstream ultrapassar 256 KB', async () => {
    const mock = vi.fn().mockResolvedValueOnce(policy()).mockResolvedValueOnce(new Response(new Uint8Array(PROFILE_PHOTO_MAX + 1)));
    await expect(new ProfilePhotoStorage(mock as unknown as typeof fetch).read(profilePhotoPath('test', person))).rejects.toThrow('invalid_stored_photo');
  });
});

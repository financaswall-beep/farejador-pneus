import { describe, it, expect, vi } from 'vitest';
import sharp from 'sharp';
import { stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
vi.mock('../../../src/shared/config/env.js', () => ({ env: {} }));
import { inspectVideo, decodeHeic } from '../../../src/marketing/publisher/media-inspection.js';
import { withMediaSource } from '../../../src/marketing/publisher/media-source.js';
import type { PublisherStorage } from '../../../src/marketing/publisher/storage.js';
import type { ProgramRunner } from '../../../src/marketing/publisher/media-process.js';

describe('Inspeção real com I/O limitado', () => {
  it('serve início e fim por Range sem carregar o vídeo completo', async () => {
    const bytes = 350 * 1024 * 1024;
    const storage = { readRange: vi.fn(async (_path: string, start: number, end: number) => Buffer.alloc(end - start + 1)) } as unknown as PublisherStorage;
    await withMediaSource(storage, 'test/object', bytes, async url => {
      const head = await fetch(url, { method: 'HEAD' });
      expect(Number(head.headers.get('Content-Length'))).toBe(bytes);
      const start = await fetch(url, { headers: { Range: 'bytes=0-' } });
      expect(start.status).toBe(206);
      expect((await start.arrayBuffer()).byteLength).toBe(4 * 1024 * 1024);
      const tail = await fetch(url, { headers: { Range: `bytes=${bytes - 128}-${bytes - 1}` } });
      expect((await tail.arrayBuffer()).byteLength).toBe(128);
      expect(await (await fetch(url + '/wrong')).text()).toBe('');
    });
    expect(storage.readRange).toHaveBeenCalledTimes(2);
    expect(storage.readRange).toHaveBeenLastCalledWith('test/object', bytes - 128, bytes - 1, bytes);
  });
  it('o orçamento cobre também requisições repetidas e encerra o decoder ao exceder', async () => {
    const storage = { readRange: vi.fn(async (_path: string, start: number, end: number) => Buffer.alloc(end - start + 1)) } as unknown as PublisherStorage;
    await expect(withMediaSource(storage, 'test/object', 350 * 1024 * 1024, async url => {
      for (let index = 0; index < 13; index++) {
        const response = await fetch(url, { headers: { Range: 'bytes=0-' } });
        await response.arrayBuffer();
        if (index === 12) expect(response.status).toBe(413);
      }
    })).rejects.toThrow('publisher_media_probe_limit');
    expect(storage.readRange).toHaveBeenCalledTimes(12);
  });
  it('executa somente MOV/MP4 sem referências externas e gera miniatura servidor', async () => {
    const thumbnail = await sharp({ create: { width: 40, height: 60, channels: 3, background: '#fff' } }).jpeg().toBuffer();
    const runner = vi.fn<ProgramRunner>().mockImplementation(async program => program === 'ffprobe'
      ? Buffer.from(JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920, avg_frame_rate: '30/1' }], format: { duration: '5' } }))
      : thumbnail);
    const result = await inspectVideo({} as PublisherStorage, 'test/object', 350 * 1024 * 1024, runner);
    expect(result).toMatchObject({ width: 1080, height: 1920, duration: 5, inspection: { verified: true, video_codec: 'h264' } });
    expect(result.thumbnail.length).toBeLessThan(256 * 1024);
    for (const [, args] of runner.mock.calls) {
      expect(args).toEqual(expect.arrayContaining(['-protocol_whitelist', 'http,tcp', '-f', 'mov', '-enable_drefs', '0', '-use_absolute_path', '0']));
      expect(args.join(' ')).not.toMatch(/service_key|supabase|signed/);
    }
  });
  it('limita HEIC antes de decodificar e remove temporários após erro', async () => {
    let source = '';
    const runner: ProgramRunner = async (program, args) => {
      source = args[0]!;
      expect(program).toBe('heif-info');
      return Buffer.from('image: 20000x20000 (id=1), primary');
    };
    await expect(decodeHeic(Buffer.from('heic'), runner)).rejects.toThrow('publisher_media_invalid');
    await expect(stat(dirname(source))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('converte HEIC isolado e elimina input/output depois de concluir', async () => {
    const jpeg = await sharp({ create: { width: 40, height: 60, channels: 3, background: '#fff' } }).jpeg().toBuffer();
    let directory = '';
    const runner: ProgramRunner = async (program, args) => {
      if (program === 'heif-info') {
        directory = dirname(args[0]!);
        return Buffer.from('image: 40x60 (id=1), primary');
      }
      expect(program).toBe('heif-convert');
      expect(args.slice(0, 2)).toEqual(['-q', '90']);
      await writeFile(args[3]!, jpeg);
      return Buffer.alloc(0);
    };
    expect(await decodeHeic(Buffer.from('heic'), runner)).toEqual(jpeg);
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

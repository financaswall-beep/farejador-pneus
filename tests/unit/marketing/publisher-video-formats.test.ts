import { it, expect, vi } from 'vitest';
import { writeFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
vi.mock('../../../src/shared/config/env.js', () => ({ env: {} }));
import { preparePublisherVideo } from '../../../src/marketing/publisher/media-video.js';
import type { PublisherStorage } from '../../../src/marketing/publisher/storage.js';
import type { ProgramRunner } from '../../../src/marketing/publisher/media-process.js';
import sharp from 'sharp';
async function fixture(finalDuration = 90) {
  const bytes = 4 * 1024 * 1024 + 12;
  const thumbnail = await sharp({ create: { width: 20, height: 40, channels: 3, background: '#abc' } }).jpeg().toBuffer();
  const storage = { readRange: vi.fn(async (_path: string, start: number, end: number) => Buffer.alloc(end - start + 1)), putFile: vi.fn() };
  let directory = '';
  const runner = vi.fn<ProgramRunner>().mockImplementation(async (program, args) => {
    const target = args.at(-1)!;
    if (program === 'ffprobe') {
      directory = dirname(target); const final = target.endsWith('vertical.mp4');
      return Buffer.from(JSON.stringify({ streams: [
        { codec_type: 'video', codec_name: final ? 'h264' : 'hevc', width: final ? 1080 : 1920, height: final ? 1920 : 1080, avg_frame_rate: final ? '30/1' : '12/1' },
        { codec_type: 'audio', codec_name: 'aac', sample_rate: final ? '48000' : '44100' },
      ], format: { duration: String(final ? finalDuration : 90) } }));
    }
    if (target === 'pipe:1') return thumbnail;
    await writeFile(target, Buffer.alloc(32)); return Buffer.alloc(0);
  });
  return { bytes, storage, runner, directory: () => directory };
}
it('baixa em blocos limitados, usa somente arquivos locais e preserva 90 segundos completos', async () => {
  const f = await fixture();
  const result = await preparePublisherVideo(f.storage as unknown as PublisherStorage, 'test/object/original.mov', f.bytes,
    { maxBytes: null, allowedMimes: null }, 'test', '00000000-0000-4000-8000-000000000001', f.runner);
  expect(f.storage.readRange.mock.calls.map(call => call.slice(1))).toEqual([[0, 4 * 1024 * 1024 - 1, f.bytes], [4 * 1024 * 1024, f.bytes - 1, f.bytes]]);
  expect(result).toMatchObject({ duration: 90, width: 1080, height: 1920, inspection: { verified: true, video_codec: 'h264', fps: 30, audio_sample_rate: 48000 } });
  const encode = f.runner.mock.calls.find(([program, args]) => program === 'ffmpeg' && args.at(-1) !== 'pipe:1')!;
  expect(encode[1][encode[1].indexOf('-t') + 1]).toBe('90');
  expect(encode[3]).toMatchObject({ timeoutMs: 180000, cpuSeconds: 150 });
  for (const [, args] of f.runner.mock.calls) {
    expect(args).toEqual(expect.arrayContaining(['-protocol_whitelist', 'file', '-enable_drefs', '0', '-use_absolute_path', '0']));
    expect(args.join(' ')).not.toMatch(/https?:|signed|service_key/);
  }
  expect(f.storage.putFile).toHaveBeenCalledTimes(1);
  await expect(stat(f.directory())).rejects.toMatchObject({ code: 'ENOENT' });
});
it('não envia arquivo truncado ao Storage e limpa temporários quando a duração muda', async () => {
  const f = await fixture(60);
  await expect(preparePublisherVideo(f.storage as unknown as PublisherStorage, 'test/object/original.mov', f.bytes,
    { maxBytes: null, allowedMimes: null }, 'test', '00000000-0000-4000-8000-000000000001', f.runner)).rejects.toThrow('publisher_media_invalid');
  expect(f.storage.putFile).not.toHaveBeenCalled();
  await expect(stat(f.directory())).rejects.toMatchObject({ code: 'ENOENT' });
});

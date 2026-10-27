import { describe, it, expect, vi } from 'vitest';
import sharp from 'sharp';
vi.mock('../../../src/shared/config/env.js', () => ({ env: {} }));
import { preparePublisherPhoto } from '../../../src/marketing/publisher/media-photo.js';
import { preparedPublishPath, preparationReady } from '../../../src/marketing/publisher/media-formats.js';
import { validateDestinationMedia } from '../../../src/marketing/publisher/media-validation.js';
import type { Media } from '../../../src/marketing/publisher/media.js';
import type { PublisherStorage } from '../../../src/marketing/publisher/storage.js';
const id = '00000000-0000-4000-8000-000000000001';
const policy = { maxBytes: null, allowedMimes: ['image/jpeg'] };
const media = { id, kind: 'photo', mime: 'image/jpeg', original_path: `test/${id}/original.jpg` } as Media;
async function prepare(input: Buffer, mime = 'image/jpeg') {
  const files = new Map<string, Buffer>();
  const storage = { read: vi.fn(async () => input), put: vi.fn(async (path: string, body: Buffer) => { files.set(path, body); }) };
  const result = await preparePublisherPhoto(storage as unknown as PublisherStorage, { ...media, mime }, policy, 'test', id);
  return { files, result, storage };
}
async function pixel(bytes: Buffer, x: number, y: number) {
  return [...await sharp(bytes).extract({ left: x, top: y, width: 1, height: 1 }).removeAlpha().raw().toBuffer()];
}
describe('adaptação das fotos por destino', () => {
  it('adapta a foto vertical do caso real para Feed e Story preservando as duas bordas', async () => {
    const input = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="2560"><rect width="1440" height="2560" fill="white"/><rect width="40" height="2560" fill="red"/><rect x="1400" width="40" height="2560" fill="blue"/></svg>')).jpeg().toBuffer();
    const { files, result } = await prepare(input);
    const feed = files.get(`test/${id}/feed-v1.jpg`)!, story = files.get(`test/${id}/vertical-v1.jpg`)!;
    expect(await sharp(feed).metadata()).toMatchObject({ width: 1080, height: 1350, format: 'jpeg', space: 'srgb' });
    expect(await sharp(story).metadata()).toMatchObject({ width: 1080, height: 1920, format: 'jpeg' });
    const left = await pixel(feed, 170, 600), right = await pixel(feed, 910, 600);
    expect(left[0]).toBeGreaterThan(220); expect(left[2]).toBeLessThan(50);
    expect(right[2]).toBeGreaterThan(220); expect(right[0]).toBeLessThan(50);
    expect((await pixel(feed, 10, 600))[0]).toBeGreaterThan(220);
    expect((await pixel(story, 10, 600))[2]).toBeLessThan(50);
    expect((await pixel(story, 1070, 600))[0]).toBeLessThan(50);
    const ready = { ...media, publish_path: result.publishPath, ...result };
    expect(preparationReady(ready)).toBe(true);
    expect(() => validateDestinationMedia(ready, [{ platform: 'instagram', format: 'feed' }, { platform: 'facebook', format: 'story' }])).not.toThrow();
    expect(preparedPublishPath(ready, 'feed')).toBe(`test/${id}/feed-v1.jpg`);
    expect(preparedPublishPath(ready, 'story')).toBe(`test/${id}/vertical-v1.jpg`);
    expect(feed.length + story.length).toBeLessThan(8 * 1024 * 1024);
  });
  it('normaliza orientação EXIF e transparência sem conservar metadados da foto', async () => {
    const input = await sharp({ create: { width: 1000, height: 600, channels: 4, background: '#00ff0080' } }).png().withMetadata({ orientation: 6 }).toBuffer();
    const { files } = await prepare(input, 'image/png');
    for (const bytes of files.values()) {
      const meta = await sharp(bytes).metadata();
      expect(meta.orientation).toBeUndefined(); expect(meta.exif).toBeUndefined(); expect(meta.hasAlpha).toBe(false);
    }
  });
  it('preserva caminhos antigos quando não há versões preparadas', () => {
    expect(preparedPublishPath({ ...media, publish_path: 'test/old/publish.jpg' }, 'feed')).toBe('test/old/publish.jpg');
    expect(preparationReady(media)).toBe(false);
  });
});

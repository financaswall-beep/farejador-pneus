import sharp from 'sharp';
import type { Media } from './media.js';
import { assertUploadPolicy, type PublisherStorage, type BucketPolicy } from './storage.js';
import { decodeHeic, type MediaInspection } from './media-inspection.js';
import { MAX_PHOTO_DERIVATIVES, MAX_PHOTO_SOURCE_BYTES, preparedPath } from './media-formats.js';
import { PublisherError } from './model.js';

/** Mantém a foto inteira; a borda clara completa o espaço que faltar, sem esticar nem cortar. */
export async function preparePublisherPhoto(storage: PublisherStorage, media: Media, policy: BucketPolicy,
  environment: string, id: string) {
  let input = await storage.read(media.original_path, MAX_PHOTO_SOURCE_BYTES);
  if (['image/heic', 'image/heif'].includes(media.mime)) input = await decodeHeic(input);
  const image = sharp(input, { limitInputPixels: 40_000_000 }).rotate().flatten({ background: '#f4f5f3' }).toColourspace('srgb');
  const meta = await image.metadata();
  if (!['jpeg', 'png', 'webp'].includes(meta.format ?? '')) throw new PublisherError('publisher_media_invalid', 400);
  const profiles: NonNullable<MediaInspection['prepared']>['profiles'] = {};
  for (const [profile, height] of [['feed', 1350], ['vertical', 1920]] as const) {
    let jpeg: Buffer | undefined;
    for (const quality of [88, 78, 68]) {
      jpeg = await image.clone().resize(1080, height, { fit: 'contain', background: '#f4f5f3' }).jpeg({ quality }).toBuffer();
      if (jpeg.length <= MAX_PHOTO_DERIVATIVES / 2 && (policy.maxBytes === null || jpeg.length <= policy.maxBytes)) break;
    }
    if (!jpeg || jpeg.length > MAX_PHOTO_DERIVATIVES / 2) throw new PublisherError('publisher_media_too_large', 413);
    assertUploadPolicy(policy, jpeg.length, 'image/jpeg');
    await storage.put(preparedPath(environment, id, 'photo', profile), jpeg);
    profiles[profile] = { width: 1080, height, bytes: jpeg.length };
  }
  const thumbnail = await image.clone().resize(400, 400, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 72 }).toBuffer();
  return { publishPath: preparedPath(environment, id, 'photo', 'feed'), thumbnail,
    width: 1080, height: 1350, duration: null,
    inspection: { verified: true, prepared: { version: 1, profiles } } as MediaInspection };
}

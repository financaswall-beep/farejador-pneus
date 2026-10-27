import sharp from 'sharp';
import { sniffImageMime } from '../parceiro/photo-upload.js';

export const PROFILE_UPLOAD_MAX = 12 * 1024 * 1024;
export const PROFILE_PHOTO_MAX = 256 * 1024;
export class ProfilePhotoError extends Error {
  constructor(message: string, public readonly status = 503) { super(message); }
}

/** Uma foto por pessoa; recorte quadrado, orientação corrigida e sem EXIF/GPS. */
export async function compactProfilePhoto(input: Buffer): Promise<Buffer> {
  if (!input.length || input.length > PROFILE_UPLOAD_MAX) throw new ProfilePhotoError('photo_too_large', 413);
  if (!sniffImageMime(input)) throw new ProfilePhotoError('not_an_image', 415);
  try {
    const bytes = await sharp(input, { limitInputPixels: 30_000_000, animated: false })
      .rotate().flatten({ background: '#fff' })
      .resize(512, 512, { fit: 'cover', position: 'centre' })
      .webp({ quality: 82, effort: 4 }).toBuffer();
    if (bytes.length > PROFILE_PHOTO_MAX) throw new Error('photo_too_large');
    return bytes;
  } catch { throw new ProfilePhotoError('invalid_photo', 415); }
}

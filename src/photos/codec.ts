import sharp from 'sharp';
import { PhotoRejectedError, sniffImageMime } from '../parceiro/photo-upload.js';

/** Perfil único do arquivo guardado. Sem EXIF/GPS; preserva orientação e proporção. */
export async function compactTirePhoto(input: Buffer) {
  if (!sniffImageMime(input)) throw new PhotoRejectedError('not_an_image');
  try {
    const result = await sharp(input, { limitInputPixels: 30_000_000, animated: false })
      .rotate().flatten({ background: '#fff' })
      .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82, effort: 4 }).toBuffer({ resolveWithObject: true });
    return { bytes: result.data, mime: 'image/webp' as const,
      width: result.info.width, height: result.info.height };
  } catch { throw new PhotoRejectedError('decode_failed'); }
}

/** WhatsApp recebe JPEG; a cópia maior existe apenas na memória durante o envio. */
export async function tirePhotoForWhatsApp(bytes: Buffer, mime: string) {
  if (mime === 'image/jpeg') return { bytes, mime };
  const result = await sharp(bytes, { limitInputPixels: 30_000_000 }).rotate()
    .flatten({ background: '#fff' }).jpeg({ quality: 85, mozjpeg: true }).toBuffer();
  return { bytes: result, mime: 'image/jpeg' };
}

/**
 * Foto sob demanda — validação e re-encode do upload do borracheiro.
 *
 * Exigências do seguranca (PLANO_FOTO_SOB_DEMANDA_2026-06-10):
 *   E7  — tipo real por MAGIC BYTES (não extensão/Content-Type); só JPEG/PNG/WebP;
 *         SVG nem entra (é texto, não casa com assinatura nenhuma).
 *   E8  — RE-ENCODE no servidor (decode → re-emite JPEG): mata payload polyglot
 *         (arquivo que é imagem válida + HTML/script) e normaliza o formato.
 *   E12 — EXIF some de graça: sharp não preserva metadata sem .withMetadata(),
 *         e o .rotate() sem args APLICA a orientação EXIF antes de descartá-la
 *         (senão a foto de celular chega deitada no cliente).
 *
 * Saída é SEMPRE image/jpeg (foto de pneu não precisa de alpha; simplifica o
 * contrato com o banco e com o Chatwoot).
 */

import sharp from 'sharp';

export const PHOTO_MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8MB — teto do POST (bodyLimit)
const MAX_DIMENSION = 1600; // maior lado após resize (o front já comprime; isto é o teto do servidor)
const JPEG_QUALITY = 80;
// Teto de pixels DECODIFICADOS (zip-bomb de imagem: arquivo pequeno, 500MP ao abrir).
const MAX_INPUT_PIXELS = 30_000_000; // ~30MP cobre qualquer câmera de celular

export type SniffedMime = 'image/jpeg' | 'image/png' | 'image/webp';

/**
 * Identifica o tipo REAL pelo cabeçalho do arquivo. null = não é imagem aceita
 * (inclui SVG, GIF, PDF, HTML disfarçado etc.).
 */
export function sniffImageMime(buffer: Buffer): SniffedMime | null {
  if (buffer.length < 12) return null;
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) {
    return 'image/png';
  }
  // WebP: "RIFF" .... "WEBP"
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

export class PhotoRejectedError extends Error {
  constructor(public readonly reason: 'not_an_image' | 'decode_failed') {
    super(`photo rejected: ${reason}`);
  }
}

export interface ReencodedPhoto {
  bytes: Buffer;
  mime: 'image/jpeg';
  width: number;
  height: number;
}

/**
 * Decodifica e re-emite a foto como JPEG limpo (máx 1600px, EXIF aplicado e
 * descartado). Lança PhotoRejectedError se não for imagem aceita ou não decodificar.
 */
export async function reencodePhoto(input: Buffer): Promise<ReencodedPhoto> {
  if (sniffImageMime(input) === null) throw new PhotoRejectedError('not_an_image');

  try {
    const out = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate() // aplica EXIF orientation ANTES do strip (senão pneu deitado)
      .resize({
        width: MAX_DIMENSION,
        height: MAX_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });

    return {
      bytes: out.data,
      mime: 'image/jpeg',
      width: out.info.width,
      height: out.info.height,
    };
  } catch (err) {
    if (err instanceof PhotoRejectedError) throw err;
    // sharp não decodificou (corrompido, polyglot quebrado, formato mentiroso).
    throw new PhotoRejectedError('decode_failed');
  }
}

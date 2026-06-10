import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  sniffImageMime,
  reencodePhoto,
  PhotoRejectedError,
} from '../../../src/parceiro/photo-upload.js';

// Gera imagens REAIS em memória — o teste prova contra bytes de verdade,
// não contra mocks (é exatamente o caminho do upload do borracheiro).
async function makeImage(format: 'jpeg' | 'png' | 'webp', width = 64, height = 64): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 30, g: 30, b: 30 } },
  })[format]().toBuffer();
}

describe('sniffImageMime (E7 — tipo real por magic bytes)', () => {
  it('identifica JPEG/PNG/WebP reais', async () => {
    expect(sniffImageMime(await makeImage('jpeg'))).toBe('image/jpeg');
    expect(sniffImageMime(await makeImage('png'))).toBe('image/png');
    expect(sniffImageMime(await makeImage('webp'))).toBe('image/webp');
  });

  it('rejeita SVG (stored XSS) mesmo "parecendo" imagem', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(sniffImageMime(svg)).toBeNull();
  });

  it('rejeita HTML, lixo e buffer curto', () => {
    expect(sniffImageMime(Buffer.from('<html><body>oi</body></html>'))).toBeNull();
    expect(sniffImageMime(Buffer.from('nao sou imagem nenhuma'))).toBeNull();
    expect(sniffImageMime(Buffer.from([0xff, 0xd8]))).toBeNull(); // curto demais
  });

  it('rejeita GIF (fora da allowlist)', () => {
    const gifHeader = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(20)]);
    expect(sniffImageMime(gifHeader)).toBeNull();
  });
});

describe('reencodePhoto (E8/E12 — re-encode + strip EXIF)', () => {
  it('re-encoda JPEG grande pra <=1600px mantendo proporção', async () => {
    const big = await makeImage('jpeg', 2400, 1200);
    const out = await reencodePhoto(big);
    expect(out.mime).toBe('image/jpeg');
    expect(out.width).toBe(1600);
    expect(out.height).toBe(800);
    expect(sniffImageMime(out.bytes)).toBe('image/jpeg');
  });

  it('não amplia foto pequena (withoutEnlargement)', async () => {
    const small = await makeImage('jpeg', 200, 100);
    const out = await reencodePhoto(small);
    expect(out.width).toBe(200);
    expect(out.height).toBe(100);
  });

  it('converte PNG e WebP pra JPEG (saída única)', async () => {
    const png = await reencodePhoto(await makeImage('png'));
    const webp = await reencodePhoto(await makeImage('webp'));
    expect(png.mime).toBe('image/jpeg');
    expect(sniffImageMime(png.bytes)).toBe('image/jpeg');
    expect(webp.mime).toBe('image/jpeg');
    expect(sniffImageMime(webp.bytes)).toBe('image/jpeg');
  });

  it('aplica EXIF orientation (rotate) e DESCARTA o EXIF da saída', async () => {
    // Foto 80x40 com orientation 6 (90° horário): celular salvo "deitado".
    const rotated = await sharp({
      create: { width: 80, height: 40, channels: 3, background: { r: 9, g: 9, b: 9 } },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();

    const out = await reencodePhoto(rotated);
    // rotate() aplicou: dimensões trocaram (40x80 = foto em pé).
    expect(out.width).toBe(40);
    expect(out.height).toBe(80);
    // EXIF sumiu da saída (sem marcador "Exif\0\0").
    expect(out.bytes.includes(Buffer.from('Exif'))).toBe(false);
    // E a saída não tem mais orientation pendente (re-leitura limpa).
    const meta = await sharp(out.bytes).metadata();
    expect(meta.orientation ?? 1).toBe(1);
  });

  it('rejeita SVG com not_an_image', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    await expect(reencodePhoto(svg)).rejects.toThrow(PhotoRejectedError);
    await expect(reencodePhoto(svg)).rejects.toMatchObject({ reason: 'not_an_image' });
  });

  it('rejeita header JPEG com corpo lixo (decode_failed)', async () => {
    const fake = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0x41)]);
    await expect(reencodePhoto(fake)).rejects.toMatchObject({ reason: 'decode_failed' });
  });
});

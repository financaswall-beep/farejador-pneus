import { describe,expect,it } from 'vitest';
import sharp from 'sharp';
import { compactTirePhoto,tirePhotoForWhatsApp } from '../../../src/photos/codec.js';

describe('Foto compacta e entrega compatível',()=>{
  it('aplica orientação, tira EXIF e reduz uma foto real para WebP sem ampliar',async()=>{
    const original=await sharp({ create:{ width:2400,height:1200,channels:3,background:'#123456' } })
      .jpeg({ quality:95 }).withMetadata({ orientation:6 }).toBuffer();
    const photo=await compactTirePhoto(original);
    expect(photo.mime).toBe('image/webp'); expect(photo.width).toBe(600);expect(photo.height).toBe(1200);
    const metadata=await sharp(photo.bytes).metadata(); expect(metadata.exif).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();expect(photo.bytes.length).toBeLessThan(original.length);
    const jpeg=await tirePhotoForWhatsApp(photo.bytes,photo.mime);
    expect((await sharp(jpeg.bytes).metadata()).format).toBe('jpeg');
    expect(jpeg.mime).toBe('image/jpeg');expect((await sharp(jpeg.bytes).metadata()).height).toBe(1200);
  });
  it('não amplia e não aceita HTML, SVG ou imagem corrompida',async()=>{
    const original=await sharp({ create:{ width:60,height:120,channels:3,background:'#456789' } }).png().toBuffer();
    expect(await compactTirePhoto(original)).toMatchObject({width:60,height:120});
    await expect(compactTirePhoto(Buffer.from('<svg></svg>'))).rejects.toMatchObject({reason:'not_an_image'});
    await expect(compactTirePhoto(Buffer.from([255,216,255,...Array(40).fill(0)]))).rejects.toMatchObject({reason:'decode_failed'});
  });
});

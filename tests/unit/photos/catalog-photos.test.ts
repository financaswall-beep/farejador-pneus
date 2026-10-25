import { describe,expect,it } from 'vitest';
import sharp from 'sharp';
Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgres://test',CHATWOOT_HMAC_SECRET:'test',ADMIN_AUTH_TOKEN:'test'});
const {folderSchema,driveAngle}=await import('../../../src/catalog-photos/model.js');
const {prepareCatalogPhoto}=await import('../../../src/catalog-photos/codec.js');
describe('fotos do catálogo da Matriz',()=>{
 it('aceita pasta/ID do Drive, rejeita URLs externas e injeção na consulta',()=>{
  expect(folderSchema.parse('https://drive.google.com/drive/folders/1234567890_abc?usp=sharing')).toBe('1234567890_abc');
  expect(folderSchema.parse('')).toBeNull();
  for(const value of ['https://evil.example/folders/1234567890','https://drive.google.com.evil/folders/1234567890',"abc' or trashed=false"])
   expect(folderSchema.safeParse(value).success).toBe(false);
 });
 it('associa somente nomes explícitos e não adivinha produto ou ângulo',()=>{
  expect(driveAngle('PRINCIPAL.JPG')).toBe('front');expect(driveAngle('Lateral.webp')).toBe('side');
  expect(driveAngle('traseira.png')).toBe('detail');expect(driveAngle('IMG_2934.jpg')).toBeNull();
  expect(driveAngle('principal-do-outro-pneu.jpg')).toBeNull();
 });
 it('preserva a proporção, remove metadados e aplica uma marca ao derivado, mantendo cópia sem marca',async()=>{
  const input=await sharp({create:{width:800,height:600,channels:3,background:'#667788'}}).jpeg().toBuffer();
  const result=await prepareCatalogPhoto(input);
  expect(result).toMatchObject({width:800,height:600});expect(result.photo.equals(result.original)).toBe(false);
  expect(await sharp(result.photo).metadata()).toMatchObject({format:'webp',width:800,height:600});
  expect((await sharp(result.original).metadata()).exif).toBeUndefined();
 });
 it('rejeita arquivo não imagem, imagem pequena e upload grande antes de processar',async()=>{
  await expect(prepareCatalogPhoto(Buffer.from('<script>bad</script>'))).rejects.toMatchObject({code:'not_an_image'});
  const small=await sharp({create:{width:80,height:80,channels:3,background:'white'}}).png().toBuffer();
  await expect(prepareCatalogPhoto(small)).rejects.toMatchObject({code:'invalid_or_small_photo'});
  await expect(prepareCatalogPhoto(Buffer.alloc(10*1024*1024+1))).rejects.toMatchObject({code:'photo_too_large'});
 });
});

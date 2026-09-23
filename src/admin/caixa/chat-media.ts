import { reencodePhoto, PhotoRejectedError } from '../../parceiro/photo-upload.js';

export const CHAT_MEDIA_MAX = 16 * 1024 * 1024;
export async function parseOperatorMedia(input: { mime: string; base64: string }) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64)) throw Error('chat_media_invalid');
  const bytes = Buffer.from(input.base64,'base64');
  if (!bytes.length || bytes.length>CHAT_MEDIA_MAX) throw Error('chat_media_invalid');
  if (['image/jpeg','image/png','image/webp'].includes(input.mime)) {
    try {
      const photo=await reencodePhoto(bytes);
      return {bytes:photo.bytes,mime:photo.mime,filename:'foto.jpg'};
    } catch (error) { if (error instanceof PhotoRejectedError) throw Error('chat_media_invalid'); throw error; }
  }
  const head=bytes.subarray(0,32), ascii=head.toString('ascii');
  const allowed: Record<string,{ extension:string; valid:boolean }> = {
    'audio/webm':{extension:'webm',valid:head.subarray(0,4).toString('hex')==='1a45dfa3'},
    'audio/ogg':{extension:'ogg',valid:ascii.startsWith('OggS')},
    'audio/mp4':{extension:'m4a',valid:ascii.slice(4,8)==='ftyp'},
    'video/mp4':{extension:'mp4',valid:ascii.slice(4,8)==='ftyp'},
    'audio/mpeg':{extension:'mp3',valid:ascii.startsWith('ID3') || (head[0]===255 && ((head[1] ?? 0)&224)===224)},
    'application/pdf':{extension:'pdf',valid:ascii.startsWith('%PDF-')},
  };
  const type=allowed[input.mime];
  if (!type?.valid) throw Error('chat_media_invalid');
  return {bytes,mime:input.mime,filename:`anexo.${type.extension}`};
}

import { allowedAudioUrl } from '../../atendente-v2/audio-transcription.js';
import { env } from '../../shared/config/env.js';
export const DOT_FILE_MAX=16*1024*1024;
/** Only a DB-resolved reference reaches here. Never forwards a bearer token or cookies. */
export async function downloadDotAttachment(value:string,fetcher:typeof fetch=fetch):Promise<Buffer> {
  const hosts=[...env.BOT_AUDIO_ALLOWED_HOSTS];
  if(env.CHATWOOT_API_BASE_URL)hosts.push(new URL(env.CHATWOOT_API_BASE_URL).hostname);
  if(env.SUPABASE_STORAGE_URL)hosts.push(new URL(env.SUPABASE_STORAGE_URL).hostname);
  let url=allowedAudioUrl(value,hosts);
  const signal=AbortSignal.timeout(20000);
  for(let hop=0;hop<4;hop++) {
  const response=await fetcher(url,{redirect:'manual',signal});
  if([301,302,303,307,308].includes(response.status)) {
    const location=response.headers.get('location');await response.body?.cancel();
    if(!location)throw Error('attachment_unavailable');
    url=allowedAudioUrl(new URL(location,url).href,hosts);continue;
  }
  if(!response.ok||!response.body)throw Error('attachment_unavailable');
  if(Number(response.headers.get('content-length'))>DOT_FILE_MAX){await response.body.cancel();throw Error('attachment_too_large');}
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let length=0;
  try {
    while(true){const part=await reader.read();if(part.done)break;length+=part.value.length;
      if(length>DOT_FILE_MAX)throw Error('attachment_too_large');chunks.push(part.value);}
  }finally{await reader.cancel().catch(()=>undefined);}
  if(!length)throw Error('attachment_empty');return Buffer.concat(chunks);
  }
  throw Error('attachment_unavailable');
}

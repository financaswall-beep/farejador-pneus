import { env } from '../../shared/config/env.js';
import { PublisherError } from './model.js';
type FetchBody = NonNullable<Parameters<typeof fetch>[1]>['body'];

/** URLs sempre derivadas do host configurado; a chave nunca vai ao navegador nem a logs. */
export class PublisherStorage {
  constructor(private fetcher: typeof fetch = fetch) {}
  private base(): string {
    if (!env.SUPABASE_STORAGE_URL || !env.SUPABASE_STORAGE_SERVICE_KEY) {
      throw new PublisherError('publisher_storage_missing',503);
    }
    return `${env.SUPABASE_STORAGE_URL.replace(/\/$/,'')}/storage/v1`;
  }
  private object(path: string): string {
    if (!/^(prod|test)\/[a-f0-9-]{36}\/(original\.(jpg|png|webp|mp4|mov)|publish\.jpg|thumbnail\.jpg)$/.test(path)) throw new PublisherError('publisher_storage_path',400);
    return `${env.MARKETING_PUBLICATIONS_BUCKET}/${path}`;
  }
  private async request(path: string, method='GET', body?: string | Uint8Array, headers: Record<string,string> = {}): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.base()}${path}`, {method, redirect:'error',
        headers:{Authorization:`Bearer ${env.SUPABASE_STORAGE_SERVICE_KEY}`, apikey:env.SUPABASE_STORAGE_SERVICE_KEY!,
          'Content-Type':'application/json',...headers}, ...(body ? {body:body as FetchBody}:{}), signal:AbortSignal.timeout(30_000)});
    } catch { throw new PublisherError('publisher_storage_unavailable',502); }
    if (!response.ok) {await response.body?.cancel();throw new PublisherError('publisher_storage_rejected',502);}
    return response;
  }
  private signed(value: unknown, expected: string): string {
    if (typeof value !== 'string' || !value.startsWith(expected)) throw new PublisherError('publisher_storage_response',502);
    const result = new URL(this.base()+value);
    if (result.origin !== new URL(this.base()).origin) throw new PublisherError('publisher_storage_response',502);
    return result.toString();
  }
  async assertPrivateBucket(): Promise<void> {
    const data = await (await this.request(`/bucket/${env.MARKETING_PUBLICATIONS_BUCKET}`)).json() as {public?:boolean};
    if (data.public !== false) throw new PublisherError('publisher_bucket_must_be_private',503);
  }
  async uploadUrl(path: string): Promise<string> {
    const target = this.object(path);
    const data = await (await this.request(`/object/upload/sign/${target}`,'POST','{}')).json() as {url?:unknown};
    return this.signed(data.url,`/object/upload/sign/${target}?`);
  }
  async signedUrl(path: string, expires=3600): Promise<string> {
    const target = this.object(path);
    const data = await (await this.request(`/object/sign/${target}`,'POST',JSON.stringify({expiresIn:expires}))).json() as {signedURL?:unknown};
    return this.signed(data.signedURL,`/object/sign/${target}?`);
  }
  async info(path: string): Promise<{bytes:number; mime:string}> {
    const data = await (await this.request(`/object/info/${this.object(path)}`)).json() as {
      size?:number; content_type?:string; metadata?:{size?:number;mimetype?:string};
    };
    return {bytes:Number(data.metadata?.size ?? data.size),mime:String(data.metadata?.mimetype ?? data.content_type ?? '')};
  }
  async read(path: string, max: number, range=false): Promise<Buffer> {
    const response = await this.request(`/object/${this.object(path)}`,'GET',undefined,range?{Range:`bytes=0-${max-1}`} : {});
    const reader = response.body?.getReader();
    if (!reader) throw new PublisherError('publisher_storage_response',502);
    let bytes=0; const parts:Uint8Array[]=[];
    try {
      while (true) {
        const part=await reader.read(); if(part.done) break;
        const available=max-bytes;
        if (part.value.byteLength>available && !range) throw new PublisherError('publisher_media_too_large',413);
        parts.push(part.value.subarray(0,available));bytes+=Math.min(part.value.byteLength,available);
        if(bytes>=max && range)break;
      }
    } finally {await reader.cancel();}
    return Buffer.concat(parts);
  }
  async put(path:string, body:Buffer, mime='image/jpeg'):Promise<void> {
    const response=await this.request(`/object/${this.object(path)}`,'POST',body,{'Content-Type':mime,'x-upsert':'true'});
    await response.body?.cancel();
  }
  async remove(paths:string[]):Promise<void> {
    if(!paths.length)return;
    paths.forEach(p=>this.object(p));
    const response=await this.request(`/object/${env.MARKETING_PUBLICATIONS_BUCKET}`,'DELETE',JSON.stringify({prefixes:[...new Set(paths)]}));
    await response.body?.cancel();
  }
}

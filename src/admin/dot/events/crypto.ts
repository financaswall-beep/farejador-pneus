import { createCipheriv,createDecipheriv,createHmac,randomBytes,timingSafeEqual } from 'node:crypto';
import { env } from '../../../shared/config/env.js';

export function signingKey(secret:string):Buffer {
  if(!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret))throw new Error('invalid_signing_secret');
  const key=Buffer.from(secret.slice(6),'base64');
  if(key.length<24||key.length>64||key.toString('base64').replace(/=+$/,'')!==secret.slice(6).replace(/=+$/,''))
    throw new Error('invalid_signing_secret');
  return key;
}
function encryptionKey() {
  const key=Buffer.from(env.DOT_EVENTS_ENCRYPTION_KEY??'','base64');
  if(key.length!==32)throw new Error('dot_events_key_missing');
  return key;
}
export function seal(secret:string,subscriptionId:string) {
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',encryptionKey(),nonce);
  cipher.setAAD(Buffer.from(subscriptionId));
  const bytes=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);
  return Buffer.concat([nonce,cipher.getAuthTag(),bytes]).toString('base64');
}
export function unseal(value:string,subscriptionId:string) {
  const bytes=Buffer.from(value,'base64'),decipher=createDecipheriv('aes-256-gcm',encryptionKey(),bytes.subarray(0,12));
  decipher.setAAD(Buffer.from(subscriptionId));decipher.setAuthTag(bytes.subarray(12,28));
  return Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8');
}
export function signedHeaders(id:string,body:string,subscriptionId:string,secrets:string[],now=Date.now()) {
  const timestamp=Math.floor(now/1000).toString();
  return {'content-type':'application/json','webhook-id':id,'webhook-timestamp':timestamp,
    'webhook-signature':secrets.map(secret=>'v1,'+createHmac('sha256',signingKey(secret))
      .update(`${id}.${timestamp}.${body}`).digest('base64')).join(' '),'X-MCP-Subscription-Id':subscriptionId};
}
export function equalChallenge(expected:string,actual:unknown) {
  if(typeof actual!=='string')return false;
  const a=Buffer.from(expected),b=Buffer.from(actual);
  return a.length===b.length&&timingSafeEqual(a,b);
}

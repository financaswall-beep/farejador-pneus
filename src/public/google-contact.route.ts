import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { env } from '../shared/config/env.js';
import { rateLimitHit } from '../shared/rate-limit.js';
import { googleClickInput, registerGoogleClick } from '../marketing/google-clicks.js';

export function googleContactDestination(destination:'web'|'whatsapp',reference?:string|null):string|null {
  if(destination==='whatsapp') {
    if(!env.GOOGLE_ADS_WHATSAPP_NUMBER)return null;
    return `https://wa.me/${env.GOOGLE_ADS_WHATSAPP_NUMBER}?text=${encodeURIComponent('Olá! Quero consultar pneus na 2W.'+(reference?` Ref: ${reference}`:''))}`;
  }
  if(!env.GOOGLE_ADS_WEBSITE_URL)return null;
  const url=new URL(env.GOOGLE_ADS_WEBSITE_URL);
  if(reference)url.searchParams.set('farejador_google_click_ref',reference);
  return url.href;
}

export async function registerGoogleContactRoutes(fastify:FastifyInstance):Promise<void> {
  // Nao registrar a URL do clique (contém identificador de publicidade).
  fastify.get('/marketing/google/contato',{logLevel:'silent'},async(_request,reply)=>{
    return reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer')
      .header('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
      .type('text/html').send(await readFile(resolve('painel/public/google-contact.html'),'utf8'));
  });
  fastify.get('/marketing/google/contact-config',{logLevel:'silent'},async(_request,reply)=>{
    return reply.header('Cache-Control','no-store').send({whatsapp:!!env.GOOGLE_ADS_WHATSAPP_NUMBER,website:!!env.GOOGLE_ADS_WEBSITE_URL});
  });
  fastify.post('/marketing/google/contact',{logLevel:'silent',bodyLimit:4096},async(request,reply)=>{
    // Custom header impede POST cross-site por formulario. Sem CORS autorizado.
    if(request.headers['x-farejador-contact']!=='1'||request.headers['sec-fetch-site']==='cross-site')return reply.code(403).send({error:'origin_not_allowed'});
    if(rateLimitHit(`google-contact:${request.ip}`,30,60_000))return reply.code(429).send({error:'rate_limited'});
    const body=request.body as {destination?:unknown;measurement?:unknown;click?:unknown}|null;
    if(!body||!['web','whatsapp'].includes(String(body.destination))||typeof body.measurement!=='boolean'
      ||Object.keys(body).some(k=>!['destination','measurement','click'].includes(k)))return reply.code(400).send({error:'invalid_request'});
    const destination=body.destination as 'web'|'whatsapp';
    if(!googleContactDestination(destination))return reply.code(409).send({error:'destination_unavailable'});
    let reference:string|null=null;
    if(body.measurement) {
      const parsed=googleClickInput.safeParse(body.click);
      if(!parsed.success||parsed.data.destination!==destination)return reply.code(400).send({error:'invalid_click'});
      try {reference=await registerGoogleClick(parsed.data);}
      catch { /* Atendimento continua mesmo se o vinculo de medicao estiver indisponivel. */ }
    }
    return reply.header('Cache-Control','no-store').send({url:googleContactDestination(destination,reference),measured:!!reference});
  });
}

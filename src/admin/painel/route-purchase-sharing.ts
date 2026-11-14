import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { readPurchaseSharing } from './purchase-sharing-read.js';
import { SharingError, sharingSchema, writePurchaseSharing } from './purchase-sharing-write.js';
import { mapWriteError } from './route-helpers.js';

type Guard=(request:FastifyRequest,reply:FastifyReply)=>void|Promise<unknown>;
export function registerPurchaseSharingRoutes(app:FastifyInstance,base:string,guards:Guard[],
  actor:(request:FastifyRequest)=>string) {
  const route=base+'/:id/sharing',options={preHandler:guards};
  const params=z.object({id:z.string().uuid()});
  app.get(route,options,async(req,reply)=>{
    const p=params.safeParse(req.params);if(!p.success)return reply.code(400).send({error:'Compra inválida.'});
    const client=await pool.connect();
    try{
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result=await readPurchaseSharing(client,env.FAREJADOR_ENV,p.data.id);
      await client.query('COMMIT');return reply.header('Cache-Control','no-store').send(result);
    }catch(e){await client.query('ROLLBACK');if(e instanceof Error && e.message==='Compra não encontrada.')return reply.code(404).send({error:e.message});throw e;}
    finally{client.release();}
  });
  app.post(route,options,async(req,reply)=>{
    const p=params.safeParse(req.params),body=sharingSchema.safeParse(req.body);
    if(!p.success || !body.success)return reply.code(400).send({error:'Confira os campos da divisão.'});
    if(!env.MATRIZ_CENTRAL_LEDGER)return reply.code(409).send({error:'O livro financeiro precisa estar ativo para registrar a divisão.'});
    try{return await writePurchaseSharing(p.data.id,body.data,actor(req));}
    catch(e){
      if(e instanceof SharingError)return reply.code(e.message==='Compra não encontrada.'?404:409).send({error:e.message});
      const mapped=mapWriteError(e);if(mapped.status>=500)req.log.error({err:e},'purchase sharing failed');
      return reply.code(mapped.status).send({error:mapped.error});
    }
  });
}

import type { Pool } from 'pg';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';
import { MetaCommentError } from '../../social-comments/graph.js';
import { PublisherStorage } from './storage.js';
import { PublisherGraph, type PublishingGraph } from './graph.js';
import { claimDelivery, setDelivery } from './queue.js';
import { publisherConfig } from './config.js';
import { cleanupMedia } from './cleanup.js';
import type { Environment } from './model.js';

export async function publishTick(db:Pool,environment:Environment,graph:PublishingGraph,storage=new PublisherStorage()):Promise<boolean> {
  const task=await claimDelivery(db,environment);if(!task)return false;
  let publicWrite=false;
  try {
    // Reinício após envio com resultado desconhecido: nunca repetir a chamada pública.
    if(task.status==='publishing') {
      await setDelivery(db,environment,task,'uncertain',{error:'publisher_confirmation_required'});return true;
    }
    if(task.status==='preparing') {
      const url=await storage.signedUrl(task.publish_path??task.original_path,3600);
      const container=await graph.prepare(task,url);
      await setDelivery(db,environment,task,'processing',{container});return true;
    }
    const expired=Date.now()-(task.started_at?.getTime()??Date.now())>2*3600000;
    if(task.status==='processing') {
      if(expired){await setDelivery(db,environment,task,'failed',{error:'publisher_processing_timeout'});return true;}
      if(!await graph.ready(task)){await setDelivery(db,environment,task,'processing');return true;}
      // Estado persistido ANTES da chamada irreversível. Um crash aqui será tratado como incerto.
      if(!await setDelivery(db,environment,task,'publishing'))return true;
      publicWrite=true;
      const provider=await graph.publish(task);
      await setDelivery(db,environment,task,'verifying',{provider});return true;
    }
    if(task.status==='verifying') {
      const result=await graph.verify(task);
      await setDelivery(db,environment,task,result.confirmed?'published':expired?'uncertain':'verifying',{
        url:result.url,...(!result.confirmed&&expired?{error:'publisher_confirmation_required'}:{})});
    }
  }catch(error) {
    const providerError=error instanceof MetaCommentError?error:null;
    const safe=providerError?.code??'publisher_service_unavailable';
    if(task.status==='verifying') {
      const expired=Date.now()-(task.started_at?.getTime()??Date.now())>2*3600000;
      await setDelivery(db,environment,task,expired?'uncertain':'verifying',{error:safe});
    }else {
      const uncertain=Boolean(providerError?.uncertain && (publicWrite || safe==='publisher_already_published')) || publicWrite && !providerError;
      await setDelivery(db,environment,task,uncertain?'uncertain':'failed',{error:safe});
    }
  }
  return true;
}
export function startPublisherWorker():()=>void {
  if(!publisherConfig().enabled || !publisherConfig().storage_ready)return ()=>undefined;
  let stopped=false;let timer:NodeJS.Timeout|undefined;let count=0;
  const run=async()=>{
    if(stopped)return;
    try {
      if(publisherConfig().sending)await publishTick(pool,env.FAREJADOR_ENV,new PublisherGraph());
      if(++count%12===0)await cleanupMedia(pool,env.FAREJADOR_ENV);
    }catch{logger.warn('Publisher operation deferred');}
    if(!stopped)timer=setTimeout(()=>void run(),5000);
  };
  void run();return ()=>{stopped=true;clearTimeout(timer);};
}

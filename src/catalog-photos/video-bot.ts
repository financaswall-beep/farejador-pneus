import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';
import type { OutboundRow } from '../atendente-v2/outbound-worker.js';
import { hasAgentV2Wildcard } from '../atendente-v2/conversation-scope.js';
import { env } from '../shared/config/env.js';
import { CatalogVideoStorage } from './video-storage.js';
const payloadSchema=z.object({catalog_video_id:z.string().uuid(),product_id:z.string().uuid(),unit_id:z.string().uuid(),caption:z.string().max(200)}).strict();
export const CATALOG_VIDEO_TOOL={type:'function' as const,function:{name:'pedir_video',
 description:'Envia vídeo já cadastrado do pneu da Matriz, 24h. Use somente se o cliente pedir vídeo da Matriz ou do produto já escolhido nela. Não troca a loja do parceiro. Sem vídeo, ofereça uma foto e aguarde a escolha. Não solicita gravação nova nem prova estado atual, estoque ou reserva.',
 parameters:{type:'object',properties:{
  product_id:{type:'string',description:'UUID exato do pneu já pesquisado e escolhido.'},
  product_ids:{type:'array',items:{type:'string'},minItems:1,maxItems:2,uniqueItems:true,description:'Somente para vídeo dos dois pneus escolhidos. Não combine com product_id.'},
  loja:{type:'string',enum:['matriz']},video_atual:{type:'boolean',description:'true para gravação atual do exemplar; não usa a referência.'},
 },required:['loja'],additionalProperties:false},
}};
export function catalogVideoPayload(body:string){try{return payloadSchema.parse(JSON.parse(body));}catch{return null;}}
export async function requestCatalogVideos(client:PoolClient,environment:Environment,conversationId:string,args:Record<string,unknown>){
 if(!env.MATRIZ_CATALOG_PHOTOS_ENABLED||!env.BOT_OUTBOX||!env.PHOTO_REQUESTS)return JSON.stringify({status:'video_indisponivel'});
 const input=z.object({product_id:z.string().uuid().optional(),product_ids:z.array(z.string().uuid()).min(1).max(2).optional()}).safeParse(args);
 if(!input.success||!!input.data.product_id===!!input.data.product_ids)return JSON.stringify({status:'precisa_produto'});
 if(args.loja!=='matriz')return JSON.stringify({status:'video_somente_matriz',orientacao:'Não troque a loja de um parceiro para enviar o vídeo da Matriz.'});
 const incoming=(await client.query<{id:string;content:string|null}>(`SELECT id,content FROM core.messages WHERE environment=$1
 AND conversation_id=$2 AND sender_type='contact' AND NOT is_private AND deleted_at IS NULL ORDER BY sent_at DESC,id DESC LIMIT 1`,[environment,conversationId])).rows[0];
 if(!incoming)return JSON.stringify({status:'precisa_produto'});
 if(args.video_atual===true||/\b(atual|exemplar|desgaste|hoje)\b/i.test(incoming.content??''))
  return JSON.stringify({status:'sem_video_atual',orientacao:'O vídeo cadastrado é de referência. Para uma gravação atual do exemplar, ofereça atendimento da equipe; não apresente a referência como gravação feita agora.'});
 const ids=[...new Set(input.data.product_ids??[input.data.product_id!])];
 const products=(await client.query<{id:string;product_name:string}>(`SELECT id,product_name FROM commerce.products
 WHERE environment=$1 AND id=ANY($2::uuid[]) AND product_type='tire' AND deleted_at IS NULL`,[environment,ids])).rows;
 if(products.length!==ids.length)return JSON.stringify({status:'precisa_produto'});
 const unit=(await client.query<{id:string}>("SELECT id FROM core.units WHERE environment=$1 AND slug='main' AND is_active",[environment])).rows[0];
 if(!unit)return JSON.stringify({status:'video_indisponivel'});
 const results=[];
 for(const id of ids){
  const video=(await client.query<{id:string}>(`SELECT v.id FROM commerce.matrix_catalog_videos v JOIN commerce.matrix_photo_settings s
   ON s.environment=v.environment AND s.product_id=v.product_id AND s.enabled
   WHERE v.environment=$1 AND v.product_id=$2 AND v.retired_at IS NULL`,[environment,id])).rows[0];
  if(!video){results.push({product_id:id,status:'sem_video'});continue;}
  const body=JSON.stringify({catalog_video_id:video.id,product_id:id,unit_id:unit.id,
   caption:ids.length>1?products.find(p=>p.id===id)!.product_name.replace(/^pneu\s+/i,'').slice(0,200):''});
  const echo=`catalog-video:${conversationId}:${incoming.id}:${video.id}`;
  const inserted=await client.query(`INSERT INTO ops.outbound_messages
   (environment,conversation_id,chatwoot_conversation_id,trigger_message_id,echo_id,kind,body,body_sha256,status)
   SELECT c.environment,c.id,c.chatwoot_conversation_id,$3,$4,'video_attachment',$5,$6,'pending'
   FROM core.conversations c WHERE c.environment=$1 AND c.id=$2 AND c.deleted_at IS NULL
   AND NOT EXISTS(SELECT 1 FROM ops.conversation_bot_control b WHERE b.environment=c.environment AND b.conversation_id=c.id AND b.mode='human')
   AND ($7::boolean OR c.id::text=ANY($8::text[]))
   ON CONFLICT(environment,echo_id) WHERE echo_id IS NOT NULL DO NOTHING`,[environment,conversationId,incoming.id,echo,body,
    createHash('sha256').update(body).digest('hex'),hasAgentV2Wildcard(env.AGENT_V2_CONVERSATION_IDS),env.AGENT_V2_CONVERSATION_IDS.filter(v=>v!=='*')]);
  const existing=inserted.rowCount|| (await client.query(`SELECT 1 FROM ops.outbound_messages WHERE environment=$1 AND echo_id=$2
   AND status IN ('pending','sending','sent_api_ack','core_echo_seen','delivered')`,[environment,echo])).rowCount;
  results.push({product_id:id,status:existing?'video_enfileirado':'video_nao_enfileirado'});
 }
 return JSON.stringify({status:results.every(r=>r.status==='video_enfileirado')?'videos_enfileirados':'videos_parciais',solicitacoes:results,
  orientacao:'O vídeo cadastrado vai como anexo. Ao cliente, uma frase curta, como "Olha o vídeo aí, amigo." Sem preço ou fila. Leia cada resultado: sem_video significa que não há vídeo; ofereça foto, sem enviar outra mídia sem ele pedir. Não confirme entrega nem estoque com base na fila.'});
}
export async function authorizedCatalogVideo(client:PoolClient,row:OutboundRow){
 const payload=catalogVideoPayload(row.body);
 if(!payload||!env.MATRIZ_CATALOG_PHOTOS_ENABLED||!env.PHOTO_REQUESTS||!env.BOT_OUTBOX)return null;
 const result=(await client.query<{storage_path:string}>(`SELECT v.storage_path FROM commerce.matrix_catalog_videos v
 JOIN commerce.products p ON p.environment=v.environment AND p.id=v.product_id AND p.deleted_at IS NULL
 JOIN commerce.matrix_photo_settings s ON s.environment=v.environment AND s.product_id=v.product_id AND s.enabled
 JOIN core.units u ON u.environment=v.environment AND u.id=$4 AND u.slug='main' AND u.is_active
 WHERE v.environment=$1 AND v.id=$2 AND v.product_id=$3 AND v.retired_at IS NULL`,
 [row.environment,payload.catalog_video_id,payload.product_id,payload.unit_id])).rows[0];
 return result?{...result,caption:payload.caption}:null;
}
export async function readOutboundCatalogVideo(client:PoolClient,row:OutboundRow){
 const video=await authorizedCatalogVideo(client,row);if(!video)throw new Error('catalog_video_revoked');
 return {bytes:await new CatalogVideoStorage().read(video.storage_path),caption:video.caption};
}

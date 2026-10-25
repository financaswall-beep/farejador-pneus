import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';
import { env } from '../shared/config/env.js';
import { hasAgentV2Wildcard } from '../atendente-v2/conversation-scope.js';
import type { OutboundRow } from '../atendente-v2/outbound-worker.js';
import { CatalogPhotoStorage } from './storage.js';
import { catalogPhotoPayload } from './model.js';
export const catalogCaption=(product:string)=>`Foto de referência: ${product}. A imagem mostra o modelo; não comprova o estado de um exemplar seminovo.`;
/** Called only AFTER normal stock/geographic routing has selected the fulfilling unit. */
export async function tryMatrixCatalogPhoto(client:PoolClient,environment:Environment,conversationId:string,
 productId:string,unitId:string,args:Record<string,unknown>):Promise<string|null>{
 if(!env.MATRIZ_CATALOG_PHOTOS_ENABLED||!env.BOT_OUTBOX||args.foto_atual===true)return null;
 if(!(await client.query(`SELECT 1 FROM core.units WHERE id=$1 AND environment=$2 AND slug='main' AND is_active`,[unitId,environment])).rowCount)return null;
 const incoming=(await client.query<{id:string;content:string|null}>(`SELECT id,content FROM core.messages
  WHERE environment=$1 AND conversation_id=$2 AND sender_type='contact' AND NOT is_private AND deleted_at IS NULL
  ORDER BY sent_at DESC,id DESC LIMIT 1`,[environment,conversationId])).rows[0];
 if(/\b(desgaste|sulcos?|exemplar)\b|\b(foto|imagem)\b.{0,40}\b(atual|agora|real)\b|\bestado\b.{0,35}\b(pneu|dele|desse|deste)\b|\bcomo est[aá].{0,25}\bpneu\b/i.test(incoming?.content??''))return null;
 const kind=args.tipo_foto??'principal';
 if(!['principal','lateral','detalhe','todas'].includes(String(kind)))return null;
 const angle=kind==='lateral'?'side':kind==='detalhe'?'detail':null;
 const photos=(await client.query<{id:string;product_name:string}>(`SELECT f.id,p.product_name FROM commerce.matrix_catalog_photos f
  JOIN commerce.matrix_photo_settings s ON s.environment=f.environment AND s.product_id=f.product_id AND s.enabled
  JOIN commerce.products p ON p.environment=f.environment AND p.id=f.product_id AND p.deleted_at IS NULL
  WHERE f.environment=$1 AND f.product_id=$2 AND f.retired_at IS NULL
   AND ($3::text='todas' OR ($3='principal' AND f.is_primary) OR f.angle=$4)
  ORDER BY f.is_primary DESC,f.angle LIMIT 3`,[environment,productId,kind,angle])).rows;
 if(!photos.length)return null;
 let queued=0,accepted=0;
 for(const photo of photos){
  const body=JSON.stringify({catalog_photo_id:photo.id,product_id:productId,unit_id:unitId,caption:catalogCaption(photo.product_name)});
  const echo=`catalog-photo:${conversationId}:${incoming?.id??'initial'}:${photo.id}`;
  const result=await client.query(`INSERT INTO ops.outbound_messages
   (environment,conversation_id,chatwoot_conversation_id,trigger_message_id,echo_id,kind,body,body_sha256,status)
   SELECT c.environment,c.id,c.chatwoot_conversation_id,$3,$4,'photo_attachment',$5,$6,'pending'
   FROM core.conversations c WHERE c.environment=$1 AND c.id=$2 AND c.deleted_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM ops.conversation_bot_control bc WHERE bc.environment=c.environment AND bc.conversation_id=c.id AND bc.mode='human')
    AND ($7::boolean OR c.id::text=ANY($8::text[]))
   ON CONFLICT(environment,echo_id) WHERE echo_id IS NOT NULL DO NOTHING`,
   [environment,conversationId,incoming?.id??null,echo,body,createHash('sha256').update(body).digest('hex'),
    hasAgentV2Wildcard(env.AGENT_V2_CONVERSATION_IDS),env.AGENT_V2_CONVERSATION_IDS.filter(id=>id!=='*')]);
  if(result.rowCount){queued++;accepted++;}
  else if((await client.query(`SELECT 1 FROM ops.outbound_messages WHERE environment=$1 AND echo_id=$2
    AND status IN ('pending','sending','sent_api_ack','core_echo_seen','delivered')`,[environment,echo])).rowCount)accepted++;
 }
 if(!accepted)return JSON.stringify({status:'foto_nao_enfileirada',orientacao:'O controle da conversa impediu o envio. Não prometa foto enviada.'});
 return JSON.stringify({status:queued?'foto_enfileirada':'foto_ja_enfileirada',product_id:productId,quantidade:photos.length,
  origem:'galeria_matriz',tipo:'referencia',orientacao:'Imagem de referência cadastrada. Enfileirar não comprova entrega. Não diga que é foto atual do exemplar. Não crie outro pedido de foto neste turno.'});
}
export async function authorizedCatalogPhoto(client:PoolClient,row:OutboundRow){
 const payload=catalogPhotoPayload(row.body);
 if(!payload||!env.MATRIZ_CATALOG_PHOTOS_ENABLED)return null;
 const photo=(await client.query<{storage_path:string}>(`SELECT f.storage_path FROM commerce.matrix_catalog_photos f
  JOIN commerce.matrix_photo_settings s ON s.product_id=f.product_id AND s.environment=f.environment AND s.enabled
  JOIN commerce.products p ON p.id=f.product_id AND p.environment=f.environment AND p.deleted_at IS NULL
  JOIN core.units u ON u.environment=f.environment AND u.id=$4 AND u.slug='main' AND u.is_active
  WHERE f.environment=$1 AND f.id=$2 AND f.product_id=$3 AND f.retired_at IS NULL`,
  [row.environment,payload.catalog_photo_id,payload.product_id,payload.unit_id])).rows[0];
 return photo?{...photo,caption:payload.caption}:null;
}
export async function readOutboundCatalogPhoto(client:PoolClient,row:OutboundRow){
 const photo=await authorizedCatalogPhoto(client,row);if(!photo)throw new Error('catalog_photo_revoked');
 return {bytes:await new CatalogPhotoStorage().read(photo.storage_path),mime:'image/webp',caption:photo.caption};
}

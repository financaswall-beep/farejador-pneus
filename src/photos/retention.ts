import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';
import { TirePhotoStorage } from './storage.js';

/** Apaga o arquivo, não a solicitação/histórico. Revalida encerramento sob locks. */
export async function purgeOneClosedPhotoRequest(client: PoolClient, environment: Environment, storage: TirePhotoStorage) {
  const candidate=await client.query<{ photo_request_id:string }>(
    `SELECT r.photo_request_id FROM commerce.tire_photo_retention r
     WHERE r.environment=$1 AND r.protected IS FALSE AND r.closed_at<now()-interval '48 hours'
       AND EXISTS (SELECT 1 FROM commerce.photo_request_blobs b WHERE b.photo_request_id=r.photo_request_id
         AND b.environment=r.environment AND b.deleted_at IS NULL)
     ORDER BY r.closed_at LIMIT 1`,[environment]);
  const id=candidate.rows[0]?.photo_request_id; if (!id) return false;
  await client.query(`SELECT id FROM commerce.photo_requests WHERE id=$1 AND environment=$2 FOR UPDATE`,[id,environment]);
  // Impede reabertura/alteração dos pedidos conhecidos enquanto a exclusão ocorre.
  await client.query(`SELECT c.id FROM core.conversations c JOIN commerce.photo_requests pr
    ON pr.environment=c.environment AND pr.conversation_id=c.chatwoot_conversation_id
    WHERE pr.id=$1 AND pr.environment=$2 FOR SHARE OF c`,[id,environment]);
  await client.query(`SELECT po.id FROM commerce.partner_orders po JOIN commerce.partner_order_items poi ON poi.order_id=po.id
    JOIN commerce.photo_requests pr ON pr.order_item_id=poi.id AND pr.environment=po.environment
    WHERE pr.id=$1 AND pr.environment=$2 FOR SHARE OF po`,[id,environment]);
  await client.query(`SELECT o.id FROM commerce.orders o JOIN core.conversations c ON c.id=o.source_conversation_id
    JOIN commerce.photo_requests pr ON pr.environment=c.environment AND pr.conversation_id=c.chatwoot_conversation_id
    WHERE pr.id=$1 AND pr.environment=$2 AND o.environment=$2 FOR SHARE OF o`,[id,environment]);
  await client.query(`SELECT po.id FROM commerce.partner_orders po JOIN commerce.orders o ON o.partner_order_id=po.id
    JOIN core.conversations c ON c.id=o.source_conversation_id
    JOIN commerce.photo_requests pr ON pr.environment=c.environment AND pr.conversation_id=c.chatwoot_conversation_id
    WHERE pr.id=$1 AND pr.environment=$2 AND po.environment=$2 AND o.environment=$2 FOR SHARE OF po`,[id,environment]);
  const safe=await client.query(`SELECT 1 FROM commerce.tire_photo_retention
    WHERE photo_request_id=$1 AND environment=$2 AND protected IS FALSE AND closed_at<now()-interval '48 hours'`,[id,environment]);
  if (!safe.rowCount) return false;
  const files=await client.query<{ id:string; storage_path:string|null; photo_size_bytes:number }>(
    `SELECT id,storage_path,photo_size_bytes FROM commerce.photo_request_blobs
      WHERE photo_request_id=$1 AND environment=$2 AND deleted_at IS NULL FOR UPDATE`,[id,environment]);
  await storage.remove(files.rows.flatMap(f=>f.storage_path?[f.storage_path]:[]));
  await client.query(`UPDATE commerce.photo_request_blobs SET photo_bytes=NULL,storage_path=NULL,deleted_at=now()
    WHERE photo_request_id=$1 AND environment=$2 AND deleted_at IS NULL`,[id,environment]);
  // O envio manual da Matriz pode ter uma cópia temporária no outbox operacional.
  await client.query(`UPDATE ops.operator_messages SET bytes=NULL,mime=NULL,filename=NULL
    WHERE photo_request_id=$1 AND environment=$2 AND bytes IS NOT NULL`,[id,environment]);
  await client.query(`INSERT INTO audit.events
    (environment,domain,event_type,actor_label,entity_table,entity_id,payload_after)
    VALUES ($1,'commerce','tire_photos_purged','photo-retention','commerce.photo_requests',$2,$3::jsonb)`,
    [environment,id,JSON.stringify({ retention_hours:48,files:files.rows.length,
      removed_bytes:files.rows.reduce((n,f)=>n+f.photo_size_bytes,0) })]);
  return true;
}

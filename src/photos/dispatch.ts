import type { PoolClient } from 'pg';
import { env } from '../shared/config/env.js';
import type { Environment } from '../shared/types/chatwoot.js';
import { enqueuePhotoAttachment } from '../atendente-v2/outbox-accessory.js';

/** Um UUID por ARQUIVO: vários ângulos do mesmo pneu nunca colidem no outbox. */
export async function enqueueStoredPhoto(client: Pick<PoolClient,'query'>, input: {
  environment: Environment; conversationId: number; requestId: string; blobId: string; wasLate: boolean;
}) {
  if (!env.BOT_OUTBOX) return false;
  // Outbox legado identificava o pedido inteiro. Não repete a primeira imagem
  // de um pedido que já foi enviado/enfileirado antes da troca de contrato.
  const legacy=await client.query(`SELECT 1 FROM ops.outbound_messages m
    WHERE m.environment=$1 AND m.echo_id=$2 AND m.kind='photo_attachment'
      AND $3::uuid=(SELECT b.id FROM commerce.photo_request_blobs b
        WHERE b.environment=$1 AND b.photo_request_id=$4 ORDER BY b.created_at,b.id LIMIT 1)`,
    [input.environment,`photo:${input.requestId}`,input.blobId,input.requestId]);
  if (legacy.rowCount) return false;
  return enqueuePhotoAttachment(client, {
    environment: input.environment, chatwootConversationId: input.conversationId,
    photoRequestId: input.requestId, photoBlobId: input.blobId,
    caption: input.wasLate
      ? 'Chegou! 📸 A foto do pneu que você pediu — dá uma olhada no estado.'
      : 'Ó ele aqui 📸 Foto real do que temos na loja. Dá uma olhada no estado!',
  });
}

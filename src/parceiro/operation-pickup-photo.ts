import { withPartnerContext } from './db.js';
import type { PartnerContext } from './auth.js';
import { readStoredTirePhoto, type StoredTirePhoto } from '../photos/storage.js';

/** Imagem do item exato, vinculada a uma retirada da própria unidade. */
export async function getPartnerPickupPhoto(ctx: PartnerContext, orderId: string, itemId: string) {
  const photo = await withPartnerContext(ctx.partnerUnitId, async client => {
    const result = await client.query<StoredTirePhoto>(
      `SELECT blob.photo_bytes AS bytes,blob.photo_mime AS mime,blob.storage_path
         FROM commerce.partner_orders po
         JOIN commerce.partner_order_items item ON item.order_id=po.id AND item.environment=po.environment
         JOIN commerce.photo_requests pr ON pr.order_item_id=item.id AND pr.environment=item.environment AND pr.unit_id=po.unit_id
         JOIN commerce.photo_request_blobs blob ON blob.photo_request_id=pr.id AND blob.environment=pr.environment
        WHERE po.id=$1 AND item.id=$2 AND po.environment=$3 AND po.unit_id=$4
          AND po.fulfillment_mode='pickup' AND po.deleted_at IS NULL AND po.status<>'cancelled'
          AND blob.deleted_at IS NULL AND blob.unit_id=po.unit_id
        ORDER BY pr.created_at DESC,blob.created_at ASC LIMIT 1`,
      [orderId, itemId, ctx.environment, ctx.unitId],
    );
    return result.rows[0];
  });
  return readStoredTirePhoto(photo);
}

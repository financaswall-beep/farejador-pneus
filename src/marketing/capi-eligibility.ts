/** Revalidação determinística imediatamente antes do envio à Meta. */
import type { PoolClient } from 'pg';
import type { CapiOutboxRow } from './capi.js';
import { META_BUSINESS_ACCOUNTS } from '../shared/meta-business-accounts.js';

export async function lockCapiCampaignScope(
  client: PoolClient,
  row: CapiOutboxRow,
): Promise<'matrix' | 'pending' | 'external' | 'unresolved'> {
  if (!row.campaign_scope_id) return 'unresolved';
  const result = await client.query<{ scope: 'matrix' | 'pending' | 'external' }>(
    `SELECT effective.scope
       FROM marketing.campaign_scopes s
       JOIN marketing.effective_campaign_scopes effective ON effective.environment=s.environment AND effective.id=s.id
       JOIN marketing.capi_outbox q
         ON q.environment=s.environment AND q.campaign_scope_id=s.id
      WHERE q.environment=$1 AND q.id=$2
      FOR SHARE OF s`,
    [row.environment, row.id],
  );
  return result.rows[0]?.scope ?? 'unresolved';
}

// Uma venda pode ser cancelada entre o ciclo de atribuição e o envio da fila.
// Confere a fonte novamente e segura pedido/atribuição durante o POST externo.
export async function purchaseIsStillEligible(client: PoolClient, row: CapiOutboxRow): Promise<boolean> {
  const result = await client.query<{ id: string }>(
    `SELECT a.id
       FROM marketing.order_attributions a
       JOIN marketing.ad_referrals r
         ON r.environment=a.environment AND r.id=a.referral_id
       JOIN commerce.orders o
         ON o.environment=a.environment AND o.id=a.order_id
       LEFT JOIN commerce.partner_orders po
         ON po.environment=o.environment AND po.id=o.partner_order_id
      WHERE a.environment=$1 AND a.id=$2 AND a.status='active'
        AND a.superseded_by IS NULL AND o.status<>'cancelled'
        AND NOT EXISTS (SELECT 1 FROM marketing.capi_outbox queue
          WHERE queue.environment=a.environment AND queue.attribution_id=a.id
            AND NOT marketing.meta_ad_scope_allowed(a.environment,queue.ad_account_id,r.source_id))
        AND (r.channel='whatsapp'
          OR (r.channel='messenger' AND r.business_account_id=$3)
          OR (r.channel='instagram' AND r.business_account_id=$4))
        AND (
          (po.id IS NOT NULL AND po.status<>'cancelled' AND po.deleted_at IS NULL
            AND NOT (po.fulfillment_mode='delivery' AND po.delivery_status<>'delivered')
            AND NOT po.awaiting_pickup)
          OR (po.id IS NULL AND o.status IN ('confirmed','paid','delivered')
            AND NOT (o.fulfillment_mode='delivery' AND o.delivery_status<>'delivered'))
        )
      FOR SHARE OF a,o`,
    [row.environment, row.attribution_id,
      META_BUSINESS_ACCOUNTS.facebook.id, META_BUSINESS_ACCOUNTS.instagram.id],
  );
  return result.rows.length > 0;
}

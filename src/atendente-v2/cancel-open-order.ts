import type { PoolClient } from 'pg';
import { releaseMatrizGalpaoReservation } from './matriz-stock-reservation.js';
import { applyMatrizGalpaoReturn } from './wholesale-stock-read.js';
import { postMatrizRetailCancellation } from '../admin/painel/matriz-ledger-retail-sales.js';

/** Chamador mantém BEGIN/COMMIT: estado, reserva e livro são uma única operação. */
export async function cancelOpenBotOrder(client: PoolClient, environment: 'prod' | 'test',
  orderId: string, actor: string, reason: string, expireBefore: string | null = null): Promise<void> {
  await client.query(`SELECT set_config('app.partner_actor_label',$1,true)`, [actor]);
  await client.query(`SELECT commerce.cancel_open_bot_order($1,$2,$3,$4,$5::timestamptz)`,
    [environment, orderId, actor, reason, expireBefore]);
  const result = await client.query<{ partner_order_id: string | null; updated_at: string }>(
    `SELECT partner_order_id,updated_at::text FROM commerce.orders WHERE environment=$1 AND id=$2`,
    [environment, orderId]);
  const row = result.rows[0]!;
  if (row.partner_order_id) return; // O motor do parceiro libera sua própria reserva.
  await releaseMatrizGalpaoReservation(client, environment, orderId);
  await applyMatrizGalpaoReturn(client, environment, orderId);
  await postMatrizRetailCancellation(client, environment, orderId, row.updated_at, actor, reason);
}
